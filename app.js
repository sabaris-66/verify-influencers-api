// backend/routes/influencers.js
require("dotenv").config();
const express = require("express");
const app = express();
const OpenAI = require("openai");
const cors = require("cors");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.get("/api/influencers", async (req, res) => {
  try {
    // Clear old data
    await prisma.post.deleteMany();
    await prisma.influencer.deleteMany();

    const message = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      store: true,
      messages: [
        {
          role: "user",
          content: `Generate a list of 15 health influencers with their details in JSON format. 
          Each influencer should include:
          - "id"
          - "name"
          - "category" (Nutrition/Fitness/Mental Health/Medical)
          - "trustScore" (0-100)
          - "followersCount"
          - "verifiedClaims" (number of verified claims)
          - "claims" (an array of at least 5 of their most popular claims, both verified and unverified)
          
          Each claim in the "claims" array should have:
          - "content" (the claim itself)
          - "status" ("verified" or "unverified")
          - "trustScore" (0-100)

          Sort influencers by trustScore in descending order.  
          ONLY return valid JSON with no explanation or markdown formatting.`,
        },
      ],
    });

    let responseText = message.choices[0].message.content;
    let jsonMatch = responseText.match(/```json\n([\s\S]*?)\n```/);
    let influencerData = jsonMatch
      ? JSON.parse(jsonMatch[1])
      : JSON.parse(responseText);

    // Batch insert influencers
    const createdInfluencers = await prisma.influencer.createMany({
      data: influencerData.map((influencer) => ({
        id: influencer.id,
        name: influencer.name,
        category: influencer.category,
        trustScore: influencer.trustScore,
        followersCount: influencer.followersCount,
        verifiedClaims: influencer.verifiedClaims,
      })),
    });

    // Batch insert posts
    const postsData = influencerData.flatMap((influencer) =>
      influencer.claims.map((claim) => ({
        content: claim.content,
        status: claim.status,
        trustScore: claim.trustScore,
        influencerId: influencer.id, // Assuming the OpenAI response includes the influencer ID
      }))
    );

    await prisma.post.createMany({ data: postsData });

    res.json({ message: "Influencers and posts refreshed successfully!" });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Failed to refresh influencer data" });
  }
});

// endpoint to get influencer data from database
app.get("/api/influencers/db", async (req, res) => {
  try {
    const influencers = await prisma.influencer.findMany();
    res.json(influencers);
  } catch (error) {
    console.error("Error fetching influencers from database:", error);
    res
      .status(500)
      .json({ error: "Failed to fetch influencer data from database" });
  }
});

// to get the particular influencer data
// New endpoint to fetch influencer details and posts by ID
app.get("/api/influencers/:id", async (req, res) => {
  const influencerId = parseInt(req.params.id); // Convert ID to integer
  try {
    const influencer = await prisma.influencer.findUnique({
      where: { id: influencerId },
      include: { posts: true }, // Include all posts related to the influencer
    });

    if (!influencer) {
      return res.status(404).json({ error: "Influencer not found" });
    }

    res.json(influencer);
  } catch (error) {
    console.error("Error fetching influencer details:", error);
    res.status(500).json({ error: "Failed to fetch influencer details" });
  }
});

// New endpoint to search claims by topic using OpenAI
app.post("/api/search-claims", async (req, res) => {
  const { influencerId, topic } = req.body;
  try {
    // Fetch influencer details
    const influencer = await prisma.influencer.findUnique({
      where: { id: parseInt(influencerId) },
    });

    if (!influencer) {
      return res.status(404).json({ error: "Influencer not found" });
    }

    // Use OpenAI to search for claims related to the topic
    const message = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      store: true,
      messages: [
        {
          role: "user",
          content: `Find claims made by ${influencer.name} related to ${topic}. Return the result in JSON format, containing:
          - "content" (the claim itself),
          - "status" ("verified" or "unverified"),
          - "trustScore" (0-100).
          Ensure the response is only valid JSON without any extra text or markdown formatting.`,
        },
      ],
    });

    let responseText = message.choices[0].message.content;
    let jsonMatch = responseText.match(/```json\n([\s\S]*?)\n```/);
    let claimsData = (await jsonMatch)
      ? JSON.parse(jsonMatch[1])
      : JSON.parse(responseText);

    console.log(claimsData);

    // Add new claims to the database
    // const createdPosts = await prisma.post.createMany({
    //   data: claimsData.claims.map((claim) => ({
    //     content: claim.content,
    //     status: claim.status,
    //     trustScore: claim.trustScore,
    //     influencerId: parseInt(influencerId),
    //   })),
    // });

    res.json(claimsData);
  } catch (error) {
    console.error("Error searching claims:", error);
    res.status(500).json({ error: "Failed to search claims" });
  }
});

// research search query
app.post("/api/research", async (req, res) => {
  const {
    influencer,
    topic,
    dateRange,
    claimsToAnalyze = 10,
    journals,
  } = req.body;

  try {
    // Query OpenAI for influencer data and posts dynamically
    const openAiQuery = `Find ${claimsToAnalyze} claims made about ${
      topic || "health"
    }${
      influencer ? ` by ${influencer}` : ""
    } within the ${dateRange} time period. Return as a valid JSON array with fields: content, status (verified/unverified), trustScore. Ensure the output is plain JSON without any extra text or formatting.`;
    const openAiResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      store: true,
      messages: [{ role: "user", content: openAiQuery }],
    });
    console.log(openAiResponse.choices[0].message.content);
    let responseText = openAiResponse.choices[0].message.content.trim();

    // Attempt to extract JSON if wrapped in code blocks
    const jsonMatch = responseText.match(/```json\n([\s\S]*?)\n```/);
    let posts = jsonMatch ? JSON.parse(jsonMatch[1]) : JSON.parse(responseText);

    // Generate scientific claims for each post
    const results = await Promise.all(
      posts.map(async (post) => {
        const scientificClaim = await generateScientificClaim(
          post.content,
          journals
        );
        return {
          ...post,
          scientificClaim,
        };
      })
    );

    res.json(results);
  } catch (error) {
    console.error("Error in research endpoint:", error);
    res.status(500).json({ error: "Failed to process research request" });
  }
});

// Function to generate scientific claims using OpenAI
async function generateScientificClaim(claimContent, journals) {
  try {
    const message = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "user",
          content: `Provide a scientifically verified claim related to: "${claimContent}" using sources from: ${journals.join(
            ", "
          )}. 
        Return the response as pure JSON in this format:
        { "content": "scientific claim", "source": "journal/source name" }
        Ensure the response contains only valid JSON without extra text or formatting.`,
        },
      ],
    });
    console.log(openAiResponse.choices[0].message.content);
    let responseText = message.choices[0].message.content.trim();

    // Attempt to extract JSON if wrapped in code blocks
    const jsonMatch = responseText.match(/```json\n([\s\S]*?)\n```/);
    return jsonMatch ? JSON.parse(jsonMatch[1]) : JSON.parse(responseText);
  } catch (error) {
    console.error("Error generating scientific claim:", error);
    return { content: "Failed to generate scientific claim", source: "N/A" };
  }
}

// app.get("/api/influencers/:infName", async (req, res) => {
//   const infName = req.params.infName;
//   try {
//     const message = await openai.chat.completions.create({
//       model: "gpt-4o-mini",
//       store: true,
//       messages: [
//         {
//           role: "user",
//           content: `Find some of the most popular claims (both verified and unverified) made by ${infName}.
//                 Return the result in JSON format, containing:
//                 - "content" (the claim itself),
//                 - "status" ("verified" or "unverified"),
//                 - "trustScore" (0-100).
//                 Ensure the response is only valid JSON without any extra text or markdown formatting.`,
//         },
//       ],
//     });
//     let responseText = message.choices[0].message.content;
//     console.log(responseText); // Debugging output

//     // Extract valid JSON using regex to remove markdown formatting
//     let jsonMatch = responseText.match(/```json\n([\s\S]*?)\n```/);
//     let influencerData;
//     if (jsonMatch) {
//       influencerData = await JSON.parse(jsonMatch[1]); // Extract and parse JSON
//     } else {
//       influencerData = await JSON.parse(responseText); // If no markdown, parse directly
//     }
//     res.json(influencerData);
//   } catch (error) {
//     console.error("Error:", error);
//     res.status(500).json({ error: "Failed to fetch influencer data" });
//   }
// });

// app.get("/api/influencers", async (req, res) => {
//   try {
//     const message = await openai.chat.completions.create({
//       model: "gpt-4o-mini",
//       store: true,
//       messages: [
//         {
//           role: "user",
//           content: `Generate a list of 15 health influencers with their details in JSON format.
//           Each influencer should include:
//           - "id"
//           - "name"
//           - "category" (Nutrition/Fitness/Mental Health/Medical)
//           - "trustScore" (0-100)
//           - "followersCount"
//           - "verifiedClaims" (number of verified claims)
//           - "claims" (an array of at least 5 of their most popular claims, both verified and unverified)

//           Each claim in the "claims" array should have:
//           - "content" (the claim itself)
//           - "status" ("verified" or "unverified")
//           - "trustScore" (0-100)

//           Sort influencers by trustScore in descending order.
//           ONLY return valid JSON with no explanation or markdown formatting.`,
//         },
//       ],
//     });

//     let responseText = message.choices[0].message.content;
//     console.log(responseText); // Debugging output

//     // Extract valid JSON using regex if Markdown formatting is included
//     let jsonMatch = responseText.match(/```json\n([\s\S]*?)\n```/);
//     let influencerData;

//     if (jsonMatch) {
//       influencerData = JSON.parse(jsonMatch[1]); // Extract and parse JSON
//     } else {
//       influencerData = JSON.parse(responseText); // If no markdown, parse directly
//     }

//     // Upload influencers and their posts to the database
//     for (const influencer of influencerData) {
//       // Create the influencer
//       const createdInfluencer = await prisma.influencer.create({
//         data: {
//           name: influencer.name,
//           category: influencer.category,
//           trustScore: influencer.trustScore,
//           followersCount: influencer.followersCount,
//           verifiedClaims: influencer.verifiedClaims,
//         },
//       });

//       // Create posts (claims) for the influencer
//       for (const claim of influencer.claims) {
//         await prisma.post.create({
//           data: {
//             content: claim.content,
//             status: claim.status,
//             trustScore: claim.trustScore,
//             influencerId: createdInfluencer.id, // Link the post to the influencer
//           },
//         });
//       }
//     }

//     res.json({ message: "Influencers and posts uploaded successfully!" });
//   } catch (error) {
//     console.error("Error:", error);
//     res
//       .status(500)
//       .json({ error: "Failed to fetch or upload influencer data" });
//   }
// });

app.listen(3000, () => {
  console.log("Server is running on http://localhost:3000");
});
