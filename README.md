# 하늘 (Haneul) - Korean AI Flight Search by Phone

미국 거주 한국 어르신들을 위한 **전화 기반 한국어 AI 항공권 검색 서비스**

## Why I Built This

My parents live in the US and speak Korean. Every time they want to fly to Korea, they struggle to search for flights — English-only websites are hard to navigate, and they end up asking me to look it up every time.

I wanted to build something where they could just **pick up the phone, speak Korean, and get flight prices** without needing a computer or asking for help.

That's 하늘 (Haneul). You call a phone number, talk to an AI in Korean, and it searches Google Flights for you and reads back the cheapest options — including nearby dates, layover details, and how to book.

부모님이 한국 갈 비행기 표를 알아보고 싶을 때마다 영어 사이트에서 검색을 못 하셔서 항상 저한테 부탁하셨어요. 전화 한 통이면 한국어로 AI와 대화하면서 비행기 가격을 바로 알 수 있으면 좋겠다고 생각해서 만들었습니다.

## How It Works

```
📞 전화 → Twilio → OpenAI Realtime API (한국어 음성 대화) → SerpAPI (Google Flights 검색) → 음성으로 결과 안내
```

1. 사용자가 Twilio 전화번호로 전화
2. AI가 한국어로 출발지, 도착지, 날짜 등을 물어봄
3. SerpAPI로 Google Flights 검색 (전후 3일 최저가 비교 포함)
4. 검색 결과를 한국어 음성으로 안내 (경유 상세, 더 싼 날짜 등)

## Features

- **한국어 음성 대화** — OpenAI Realtime API (gpt-4o-realtime-preview)
- **자연스러운 끼어들기** — 사용자가 말하면 AI가 즉시 멈추고 들음
- **대기 음악** — 검색 중 부드러운 차임 + 대기음
- **전후 3일 최저가 비교** — 더 싼 날짜 자동 안내
- **경유 상세 안내** — 경유지, 대기 시간 설명
- **대한항공/에어프레미아 우선** — 한국행 인기 항공사 우선 정렬

## Setup

### Prerequisites

- Node.js 18+
- [Twilio](https://twilio.com) 계정 + 전화번호
- [OpenAI](https://platform.openai.com) API key (Realtime API 접근 필요)
- [SerpAPI](https://serpapi.com) API key
- [ngrok](https://ngrok.com) (로컬 개발용 터널)

### Installation

```bash
git clone https://github.com/willcalbiz/help_parents_flight.git
cd help_parents_flight
npm install
cp .env.example .env
# .env 파일에 API 키들을 입력하세요
```

### Running

```bash
# 1. ngrok 터널 시작
ngrok http 3000

# 2. .env의 SERVER_URL을 ngrok URL로 업데이트

# 3. Twilio 콘솔에서 전화번호의 Voice webhook을:
#    https://your-ngrok-url.ngrok-free.dev/incoming-call (HTTP POST)

# 4. 서버 시작
npm start
```

### Twilio Configuration

1. Twilio 콘솔 → Phone Numbers → 구매한 번호 클릭
2. Voice Configuration:
   - **A call comes in**: Webhook
   - **URL**: `https://your-ngrok-url.ngrok-free.dev/incoming-call`
   - **HTTP Method**: HTTP POST

## Architecture

```
├── server.js              # Fastify 서버 (Twilio webhook + WebSocket)
├── lib/
│   ├── media-stream.js    # Twilio ↔ OpenAI Realtime 프록시
│   ├── prompt.js          # AI 시스템 프롬프트 (한국어 상담사)
│   ├── flights.js         # SerpAPI Google Flights 검색
│   └── hold-audio.js      # 대기 음악 생성 (g711 ulaw)
├── .env.example           # 환경 변수 템플릿
└── package.json
```

## Cost Estimate (per call)

| Service | Cost |
|---------|------|
| Twilio (수신 전화) | ~$0.0085/min |
| OpenAI Realtime | ~$0.06-0.24/min |
| SerpAPI | ~$0.01/검색 |
| **5분 통화 합계** | **~$0.50-1.50** |

## License

MIT
