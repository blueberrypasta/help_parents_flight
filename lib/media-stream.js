/**
 * Twilio Media Stream ↔ OpenAI Realtime API 프록시
 *
 * Twilio에서 들어오는 오디오를 OpenAI로 전달하고,
 * OpenAI의 응답 오디오를 Twilio로 돌려보냄
 *
 * 끼어들기(interruption) 지원:
 * 사용자가 말하면 AI 응답을 즉시 중단하고 Twilio 오디오 버퍼를 클리어
 */

import WebSocket from "ws";
import { SYSTEM_PROMPT } from "./prompt.js";
import { startHoldAudio } from "./hold-audio.js";

const OPENAI_REALTIME_URL =
  "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";

export function handleMediaStream(twilioSocket, { onFlightSearch }) {
  let streamSid = null;
  let callerNumber = null;
  let lastAssistantItemId = null; // 현재 AI 응답 추적 (끼어들기용)

  // ─── OpenAI Realtime WebSocket 연결 ───
  const openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  // ─── OpenAI 연결 성공 시 세션 설정 ───
  openaiWs.on("open", () => {
    console.log("✅ OpenAI Realtime 연결됨");

    // 세션 설정: 한국어 음성 대화
    const sessionConfig = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: SYSTEM_PROMPT,
        voice: "shimmer",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        input_audio_transcription: {
          model: "whisper-1",
        },
        turn_detection: {
          type: "server_vad",
          threshold: 0.3,           // 더 민감하게 (0.5→0.3) — 작은 소리도 감지
          prefix_padding_ms: 200,   // 음성 시작 전 패딩 줄임 (300→200)
          silence_duration_ms: 500, // 침묵 감지 더 빠르게 (800→500)
        },
        tools: [
          {
            type: "function",
            name: "search_flights",
            description:
              "항공편을 검색합니다. 출발지, 도착지, 날짜, 인원을 받아서 항공편과 가격을 검색합니다.",
            parameters: {
              type: "object",
              properties: {
                origin: {
                  type: "string",
                  description:
                    "출발 공항 IATA 코드 (예: LAX, JFK, SFO, ICN)",
                },
                destination: {
                  type: "string",
                  description:
                    "도착 공항 IATA 코드 (예: ICN, LAX, JFK)",
                },
                departure_date: {
                  type: "string",
                  description: "출발 날짜 (YYYY-MM-DD 형식)",
                },
                return_date: {
                  type: "string",
                  description:
                    "귀국 날짜 (YYYY-MM-DD 형식, 편도면 생략)",
                },
                adults: {
                  type: "integer",
                  description: "성인 탑승객 수",
                  default: 1,
                },
                cabin_class: {
                  type: "string",
                  enum: ["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"],
                  description: "좌석 등급",
                  default: "ECONOMY",
                },
              },
              required: ["origin", "destination", "departure_date"],
            },
          },
        ],
      },
    };

    openaiWs.send(JSON.stringify(sessionConfig));
  });

  // ─── OpenAI → Twilio: 응답 처리 ───
  openaiWs.on("message", async (data) => {
    const event = JSON.parse(data.toString());

    switch (event.type) {
      // AI 응답 시작 — item_id 추적 (끼어들기용)
      case "response.output_item.added":
        if (event.item?.id) {
          lastAssistantItemId = event.item.id;
        }
        break;

      // AI 응답 오디오 → Twilio로 전달
      case "response.audio.delta":
        if (event.delta && streamSid) {
          twilioSocket.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: event.delta },
            })
          );
        }
        break;

      // ─── 끼어들기 처리 ───
      // 사용자가 말하기 시작하면 → AI 응답 즉시 중단 + Twilio 오디오 클리어
      case "input_audio_buffer.speech_started":
        console.log("🗣️ 사용자 끼어들기 감지 — AI 응답 중단");

        // 1. Twilio 오디오 버퍼 클리어 (아직 재생 안 된 AI 음성 제거)
        if (streamSid) {
          twilioSocket.send(
            JSON.stringify({
              event: "clear",
              streamSid,
            })
          );
        }

        // 2. OpenAI에 현재 응답 취소 요청
        openaiWs.send(JSON.stringify({ type: "response.cancel" }));

        // 3. 잘린 AI 응답을 대화 기록에서 정리
        if (lastAssistantItemId) {
          openaiWs.send(
            JSON.stringify({
              type: "conversation.item.truncate",
              item_id: lastAssistantItemId,
              content_index: 0,
              audio_end_ms: 0,
            })
          );
        }
        break;

      // Function call: 항공편 검색
      case "response.function_call_arguments.done":
        console.log(`🔧 Function call: ${event.name}`);
        const args = JSON.parse(event.arguments);

        if (event.name === "search_flights") {
          // 🎵 검색 중 대기음 시작
          console.log("🎵 대기음 시작");
          const holdAudio = startHoldAudio(twilioSocket, streamSid);

          try {
            const results = await onFlightSearch(args);

            // 🎵 대기음 중지
            holdAudio.stop();
            console.log("🎵 대기음 중지");

            openaiWs.send(
              JSON.stringify({
                type: "conversation.item.create",
                item: {
                  type: "function_call_output",
                  call_id: event.call_id,
                  output: JSON.stringify(results),
                },
              })
            );
            openaiWs.send(JSON.stringify({ type: "response.create" }));
          } catch (err) {
            // 🎵 대기음 중지
            holdAudio.stop();

            console.error("항공편 검색 오류:", err);
            openaiWs.send(
              JSON.stringify({
                type: "conversation.item.create",
                item: {
                  type: "function_call_output",
                  call_id: event.call_id,
                  output: JSON.stringify({
                    error: "항공편 검색 중 오류가 발생했습니다.",
                  }),
                },
              })
            );
            openaiWs.send(JSON.stringify({ type: "response.create" }));
          }
        }
        break;

      // 대화 텍스트 로깅
      case "response.audio_transcript.done":
        console.log(`🤖 AI: ${event.transcript}`);
        break;

      case "conversation.item.input_audio_transcription.completed":
        console.log(`👤 사용자: ${event.transcript}`);
        break;

      case "error":
        console.error("❌ OpenAI 오류:", event.error);
        break;
    }
  });

  // ─── Twilio → OpenAI: 오디오 전달 ───
  twilioSocket.on("message", (message) => {
    const msg = JSON.parse(message.toString());

    switch (msg.event) {
      case "start":
        streamSid = msg.start.streamSid;
        callerNumber = msg.start.customParameters?.callerNumber || "unknown";
        console.log(`📱 스트림 시작 — SID: ${streamSid}, 발신: ${callerNumber}`);
        break;

      case "media":
        if (openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: msg.media.payload,
            })
          );
        }
        break;

      case "stop":
        console.log("📴 통화 종료");
        openaiWs.close();
        break;
    }
  });

  // ─── 연결 종료 처리 ───
  twilioSocket.on("close", () => {
    console.log("🔌 Twilio 연결 종료");
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });

  openaiWs.on("close", () => {
    console.log("🔌 OpenAI 연결 종료");
  });

  openaiWs.on("error", (err) => {
    console.error("❌ OpenAI WebSocket 오류:", err);
  });
}
