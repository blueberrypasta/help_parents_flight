/**
 * Twilio Media Stream ↔ OpenAI Realtime API 프록시
 *
 * Twilio에서 들어오는 오디오를 OpenAI로 전달하고,
 * OpenAI의 응답 오디오를 Twilio로 돌려보냄
 *
 * 끼어들기(interruption) 지원:
 * 사용자가 말하면 AI 응답을 즉시 중단하고 Twilio 오디오 버퍼를 클리어
 *
 * gpt-realtime-2 API 형식 (2026-05 GA)
 */

import WebSocket from "ws";
import { SYSTEM_PROMPT } from "./prompt.js";
import { startHoldAudio } from "./hold-audio.js";

const OPENAI_REALTIME_URL =
  "wss://api.openai.com/v1/realtime?model=gpt-realtime-2";

export function handleMediaStream(twilioSocket, { onFlightSearch }) {
  let streamSid = null;
  let callerNumber = null;
  let lastAssistantItemId = null; // 현재 AI 응답 추적 (끼어들기용)

  // ─── OpenAI Realtime WebSocket 연결 ───
  const openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
  });

  // ─── OpenAI 연결 성공 시 세션 설정 ───
  openaiWs.on("open", () => {
    console.log("✅ OpenAI Realtime 연결됨");

    // 세션 설정: 한국어 음성 대화 (gpt-realtime-2 새 형식)
    const sessionConfig = {
      type: "session.update",
      session: {
        type: "realtime",
        model: "gpt-realtime-2",
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            turn_detection: {
              type: "semantic_vad",   // 의미 기반 VAD — 문장 끝을 더 정확하게 감지
            },
            transcription: {
              model: "gpt-4o-mini-transcribe",  // 사용자 음성 텍스트 변환 (로깅용)
            },
          },
          output: {
            format: { type: "audio/pcmu" },
            voice: "coral",  // 따뜻하고 자연스러운 다국어 음성
          },
        },
        instructions: SYSTEM_PROMPT,
        reasoning: {
          effort: "low",  // 음성 대화 저지연 최적화 (OpenAI 권장)
        },
        tools: [
          {
            type: "function",
            name: "search_flights",
            description:
              "항공편을 검색합니다. 출발지, 도착지, 날짜, 인원, 좌석등급을 받아서 항공편과 가격을 검색합니다. 반드시 이 함수를 호출하기 전에 사용자에게 짧은 안내 멘트를 먼저 하세요.",
            parameters: {
              type: "object",
              properties: {
                origin: {
                  type: "string",
                  description:
                    "출발 공항 IATA 코드 (예: LAX, JFK, SFO, ICN). 도시명을 반드시 IATA 코드로 변환하세요.",
                },
                destination: {
                  type: "string",
                  description:
                    "도착 공항 IATA 코드 (예: ICN, LAX, JFK). 도시명을 반드시 IATA 코드로 변환하세요.",
                },
                departure_date: {
                  type: "string",
                  description: "출발 날짜 (YYYY-MM-DD 형식). 상대적 날짜 표현은 오늘 날짜 기준으로 변환.",
                },
                return_date: {
                  type: "string",
                  description:
                    "귀국 날짜 (YYYY-MM-DD 형식). 편도이면 이 필드를 생략하세요.",
                },
                adults: {
                  type: "integer",
                  description: "성인 탑승객 수 (기본값: 1)",
                  default: 1,
                },
                cabin_class: {
                  type: "string",
                  enum: ["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"],
                  description: "좌석 등급. 일반석=ECONOMY, 비즈니스석=BUSINESS, 일등석=FIRST",
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

      // AI 응답 오디오 → Twilio로 전달 (새 이벤트 이름)
      case "response.output_audio.delta":
        if (event.delta && streamSid) {
          twilioSocket.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: event.delta },
            })
          );

          // item_id 추적 (끼어들기용)
          if (event.item_id) {
            lastAssistantItemId = event.item_id;
          }
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

      // 대화 텍스트 로깅 (새 이벤트 이름)
      case "response.output_audio_transcript.done":
        console.log(`🤖 AI: ${event.transcript}`);
        break;

      // 레거시 이벤트 이름 호환
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
