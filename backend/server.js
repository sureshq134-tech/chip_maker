const http = require("node:http");

const PORT = Number(process.env.PORT || 10000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const ALLOWED_MODELS = new Set(["gpt-5.6-sol", "gpt-5.6-luna"]);
const MAX_BODY_BYTES = 24 * 1024 * 1024;
const MAX_IMAGES = 4;
const MAX_COMPLETION_TOKENS = 65500;

function sendJson(response, status, body) {
  const data = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store"
  });
  response.end(data);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON");
    error.status = 400;
    throw error;
  }
}

function validateAndNormalize(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw Object.assign(new Error("JSON body must be an object"), { status: 400 });
  }
  if (!ALLOWED_MODELS.has(body.model)) {
    throw Object.assign(new Error("Unsupported model"), { status: 400 });
  }
  if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 4) {
    throw Object.assign(new Error("messages must contain between 1 and 4 entries"), { status: 400 });
  }

  let imageCount = 0;
  for (const message of body.messages) {
    if (!message || typeof message !== "object" || !["system", "user"].includes(message.role)) {
      throw Object.assign(new Error("Only system and user messages are accepted"), { status: 400 });
    }
    if (Array.isArray(message.content)) {
      for (const item of message.content) {
        if (item && item.type === "image_url") {
          const url = item.image_url && item.image_url.url;
          if (typeof url !== "string" || !url.startsWith("data:image/jpeg;base64,")) {
            throw Object.assign(new Error("Only embedded JPEG images are accepted"), { status: 400 });
          }
          imageCount += 1;
        }
      }
    }
  }
  if (imageCount < 1 || imageCount > MAX_IMAGES) {
    throw Object.assign(new Error(`Between 1 and ${MAX_IMAGES} images are required`), { status: 400 });
  }

  const requestedTokens = Number(body.max_completion_tokens);
  return {
    model: body.model,
    reasoning_effort: "high",
    messages: body.messages,
    max_completion_tokens: Number.isFinite(requestedTokens)
      ? Math.max(1, Math.min(Math.trunc(requestedTokens), MAX_COMPLETION_TOKENS))
      : MAX_COMPLETION_TOKENS,
    ...(body.response_format && body.response_format.type === "json_object"
      ? { response_format: { type: "json_object" } }
      : {})
  };
}

const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    sendJson(response, OPENAI_API_KEY ? 200 : 503, {
      status: OPENAI_API_KEY ? "ok" : "not_configured"
    });
    return;
  }

  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    sendJson(response, 404, { error: { message: "Not found" } });
    return;
  }
  if (!OPENAI_API_KEY) {
    sendJson(response, 503, { error: { message: "Backend is not configured" } });
    return;
  }
  try {
    const body = validateAndNormalize(await readJson(request));
    const upstream = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000)
    });
    const data = await upstream.text();
    response.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") || "application/json",
      "Cache-Control": "no-store"
    });
    response.end(data);
  } catch (error) {
    const status = Number(error.status) || (error.name === "TimeoutError" ? 504 : 502);
    sendJson(response, status, { error: { message: error.message || "Backend request failed" } });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`API proxy listening on port ${PORT}`);
});
