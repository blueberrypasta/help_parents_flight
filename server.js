/**
 * 하늘(Haneul) MVP - 메인 서버
 *
 * 한국어 AI 전화 항공권 검색 서비스
 * Twilio Voice → OpenAI Realtime API → Amadeus → Twilio SMS
 */

import Fastify from "fastify";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import dotenv from "dotenv";

import { handleMediaStream } from "./lib/media-stream.js";
import { searchFlights } from "./lib/flights.js";

dotenv.config();

const app = Fastify({ logger: true });
app.register(fastifyFormBody);
app.register(fastifyWs);

// ─── Health check ───
app.get("/", async () => ({ status: "ok", service: "하늘 MVP" }));

// ─── Twilio webhook: 전화가 들어오면 TwiML로 Media Stream 연결 ───
app.post("/incoming-call", async (req, reply) => {
  const callerNumber = req.body.From || "unknown";
  app.log.info(`📞 전화 수신: ${callerNumber}`);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/media-stream">
      <Parameter name="callerNumber" value="${callerNumber}" />
    </Stream>
  </Connect>
</Response>`;

  reply.type("text/xml").send(twiml);
});

// ─── WebSocket: Twilio Media Stream ↔ OpenAI Realtime API 프록시 ───
app.register(async (app) => {
  app.get("/media-stream", { websocket: true }, (socket, req) => {
    app.log.info("🔌 Media Stream 연결됨");
    handleMediaStream(socket, {
      onFlightSearch: searchFlights,
    });
  });
});

// ─── 서버 시작 ───
const PORT = process.env.PORT || 3000;
app.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  console.log(`
  ╔═══════════════════════════════════════╗
  ║   하늘 MVP 서버 실행 중               ║
  ║   포트: ${PORT}                          ║
  ║                                       ║
  ║   Twilio Webhook:                     ║
  ║   POST ${process.env.SERVER_URL || "http://localhost:" + PORT}/incoming-call
  ║                                       ║
  ║   Media Stream:                       ║
  ║   WSS  ${process.env.SERVER_URL || "ws://localhost:" + PORT}/media-stream
  ╚═══════════════════════════════════════╝
  `);
});
