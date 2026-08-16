import "dotenv/config";

const apiUrl = process.env.HEALTH_API_URL ?? "http://127.0.0.1:4000";
const token = process.env.HEALTH_API_TOKEN;
if (!token) throw new Error("HEALTH_API_TOKEN is required");
const response = await fetch(new URL("/v1/nutrition/estimate", apiUrl), {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ text: process.argv.slice(2).join(" ") || "nasi kandar with fried chicken and mixed curry" }),
});
console.log(JSON.stringify(await response.json(), null, 2));
if (!response.ok) process.exit(1);
