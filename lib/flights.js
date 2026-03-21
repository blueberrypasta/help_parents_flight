/**
 * SerpAPI Google Flights — 항공편 검색
 *
 * 대한항공(KE)과 에어프레미아(YP) 중심으로 검색
 * + 전후 1주일 최저가 비교
 * + 경유 상세 (어디서, 얼마나 대기)
 */

const SERPAPI_BASE = "https://serpapi.com/search";

const CABIN_MAP = {
  ECONOMY: 1,
  PREMIUM_ECONOMY: 2,
  BUSINESS: 3,
  FIRST: 4,
};

const CABIN_NAMES = {
  ECONOMY: "일반석",
  PREMIUM_ECONOMY: "프리미엄 (넓은 일반석)",
  BUSINESS: "비즈니스",
  FIRST: "일등석",
};

const AIRLINE_CODES = {
  KE: "대한항공",
  YP: "에어프레미아",
  OZ: "아시아나항공",
  AA: "아메리칸항공",
  UA: "유나이티드항공",
  DL: "델타항공",
  JL: "일본항공",
  NH: "전일본공수",
  CA: "중국국제항공",
  CX: "캐세이퍼시픽",
  SQ: "싱가포르항공",
  HA: "하와이안항공",
};

/**
 * 항공편 검색 (SerpAPI Google Flights)
 * 요청 날짜 + 전후 3일씩 (총 7일) 병렬 검색하여 최저가 비교
 */
export async function searchFlights({
  origin,
  destination,
  departure_date,
  return_date,
  adults = 1,
  cabin_class = "ECONOMY",
}) {
  console.log(
    `✈️  검색: ${origin} → ${destination}, ${departure_date}, ${adults}명, ${cabin_class}`
  );

  try {
    // ─── 요청 날짜 검색 ───
    const mainData = await fetchFlights({
      origin,
      destination,
      departure_date,
      return_date,
      adults,
      cabin_class,
    });

    const mainResult = formatResults(mainData, {
      origin,
      destination,
      cabin_class,
      return_date,
      departure_date,
    });

    // ─── 전후 3일 최저가 병렬 검색 ───
    const nearbyDates = getNearbyDates(departure_date, 3);
    const nearbySearches = nearbyDates
      .filter((d) => d !== departure_date) // 요청 날짜 제외
      .map(async (date) => {
        try {
          const data = await fetchFlights({
            origin,
            destination,
            departure_date: date,
            return_date,
            adults,
            cabin_class,
          });
          const bestFlights = data.best_flights || [];
          const otherFlights = data.other_flights || [];
          const allFlights = [...bestFlights, ...otherFlights];
          const cheapest = allFlights.reduce(
            (min, f) => (f.price && f.price < min ? f.price : min),
            Infinity
          );
          return { date, price: cheapest === Infinity ? null : cheapest };
        } catch {
          return { date, price: null };
        }
      });

    const nearbyPrices = await Promise.all(nearbySearches);

    // 요청 날짜 최저가
    const requestedPrice =
      mainResult.flights.length > 0
        ? mainResult.flights[0].price_numeric
        : null;

    // 더 싼 날짜 찾기
    const cheaperDates = nearbyPrices
      .filter((d) => d.price && requestedPrice && d.price < requestedPrice)
      .sort((a, b) => a.price - b.price)
      .slice(0, 3); // 최대 3개

    // 결과에 주변 날짜 정보 추가
    mainResult.nearby_cheaper = cheaperDates.map((d) => ({
      date: d.date,
      date_korean: formatDateKorean(d.date),
      price: `$${d.price}`,
      price_numeric: d.price,
      savings: `$${requestedPrice - d.price}`,
      savings_numeric: requestedPrice - d.price,
    }));

    if (cheaperDates.length > 0) {
      mainResult.cheaper_tip = `참고: ${cheaperDates
        .map(
          (d) =>
            `${formatDateKorean(d.date)}은 $${d.price} (${requestedPrice - d.price}달러 더 쌈)`
        )
        .join(", ")}`;
    }

    return mainResult;
  } catch (err) {
    console.error("SerpAPI 오류:", err.message);

    return {
      success: false,
      message:
        "지금 시스템에서 검색이 잘 안 되고 있어요. 항공사에 직접 전화해보시는 게 좋겠어요.",
      fallback_links: [
        {
          airline: "대한항공",
          phone: "1-800-438-5000",
          url: `https://www.koreanair.com`,
        },
        {
          airline: "에어프레미아",
          phone: "1-833-623-5868",
          url: `https://www.airpremia.com`,
        },
      ],
    };
  }
}

/**
 * SerpAPI 단일 검색 호출
 */
async function fetchFlights({
  origin,
  destination,
  departure_date,
  return_date,
  adults,
  cabin_class,
}) {
  const params = new URLSearchParams({
    engine: "google_flights",
    departure_id: origin,
    arrival_id: destination,
    outbound_date: departure_date,
    adults: String(adults),
    travel_class: String(CABIN_MAP[cabin_class] || 1),
    currency: "USD",
    hl: "ko",
    api_key: process.env.SERPAPI_KEY,
  });

  if (return_date) {
    params.set("return_date", return_date);
    params.set("type", "1");
  } else {
    params.set("type", "2");
  }

  const url = `${SERPAPI_BASE}?${params.toString()}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`SerpAPI 응답 오류: ${response.status}`);
  }

  return response.json();
}

/**
 * 결과 포맷팅 — 경유 상세 정보 포함
 */
function formatResults(data, { origin, destination, cabin_class, return_date, departure_date }) {
  const bestFlights = data.best_flights || [];
  const otherFlights = data.other_flights || [];
  const allFlights = [...bestFlights, ...otherFlights];

  if (allFlights.length === 0) {
    return {
      success: false,
      message: "해당 날짜에 맞는 항공편을 찾지 못했어요. 다른 날짜로 찾아볼까요?",
      flights: [],
      nearby_cheaper: [],
    };
  }

  const priorityAirlines = new Set(["KE", "YP"]);

  const flights = allFlights.slice(0, 10).map((flight) => {
    const legs = flight.flights || [];
    const firstLeg = legs[0] || {};
    const lastLeg = legs[legs.length - 1] || {};

    const carrierCode = extractCarrierCode(firstLeg);
    const airlineName =
      AIRLINE_CODES[carrierCode] || firstLeg.airline || carrierCode;

    // 소요 시간
    const totalMinutes = flight.total_duration || 0;
    const hours = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    const duration = `${hours}시간 ${mins}분`;

    // ─── 경유 상세 정보 ───
    const stops = legs.length - 1;
    let stopInfo = "직항";
    let layoverDetails = [];

    if (stops > 0) {
      layoverDetails = flight.layovers || [];

      // SerpAPI layovers 배열이 있으면 사용
      if (layoverDetails.length > 0) {
        const layoverDescriptions = layoverDetails.map((layover) => {
          const layoverMinutes = layover.duration || 0;
          const lHours = Math.floor(layoverMinutes / 60);
          const lMins = layoverMinutes % 60;
          const timeStr =
            lHours > 0
              ? lMins > 0
                ? `${lHours}시간 ${lMins}분`
                : `${lHours}시간`
              : `${lMins}분`;
          const airportName = layover.name || layover.id || "경유지";
          return `${airportName}에서 ${timeStr} 대기`;
        });
        stopInfo = `${stops}회 경유 — ${layoverDescriptions.join(", ")}`;
      } else {
        // layovers 정보가 없으면 legs에서 계산
        const layoverCalc = [];
        for (let i = 0; i < legs.length - 1; i++) {
          const arrTime = legs[i].arrival_airport?.time;
          const depTime = legs[i + 1].departure_airport?.time;
          const airport =
            legs[i].arrival_airport?.name ||
            legs[i].arrival_airport?.id ||
            "경유지";

          if (arrTime && depTime) {
            const waitMinutes = calcMinutesBetween(arrTime, depTime);
            if (waitMinutes > 0) {
              const wH = Math.floor(waitMinutes / 60);
              const wM = waitMinutes % 60;
              const timeStr =
                wH > 0
                  ? wM > 0
                    ? `${wH}시간 ${wM}분`
                    : `${wH}시간`
                  : `${wM}분`;
              layoverCalc.push(`${airport}에서 ${timeStr} 대기`);
            } else {
              layoverCalc.push(airport);
            }
          } else {
            layoverCalc.push(airport);
          }
        }
        stopInfo = `${stops}회 경유 — ${layoverCalc.join(", ")}`;
      }
    }

    const price = flight.price || 0;
    const departureTime = firstLeg.departure_airport?.time || "";
    const arrivalTime = lastLeg.arrival_airport?.time || "";

    const bookingUrl = generateBookingUrl(
      carrierCode,
      origin,
      destination,
      departure_date
    );

    return {
      airline: airlineName,
      airline_code: carrierCode,
      flight_number: firstLeg.flight_number || `${carrierCode}`,
      departure_time: departureTime,
      departure_airport: firstLeg.departure_airport?.name || origin,
      arrival_time: arrivalTime,
      arrival_airport: lastLeg.arrival_airport?.name || destination,
      duration,
      stops: stopInfo,
      stops_count: stops,
      layover_details: layoverDetails.map((l) => ({
        airport: l.name || l.id || "경유지",
        duration_minutes: l.duration || 0,
      })),
      price: `$${price}`,
      price_numeric: price,
      cabin: CABIN_NAMES[cabin_class] || cabin_class,
      booking_url: bookingUrl,
      is_priority: priorityAirlines.has(carrierCode),
    };
  });

  // 대한항공/에어프레미아 우선, 그 다음 가격순 정렬
  flights.sort((a, b) => {
    if (a.is_priority && !b.is_priority) return -1;
    if (!a.is_priority && b.is_priority) return 1;
    return a.price_numeric - b.price_numeric;
  });

  const topFlights = flights.slice(0, 5);

  return {
    success: true,
    message: `${topFlights.length}개 항공편을 찾았어요.`,
    flights: topFlights,
    trip_type: return_date ? "왕복" : "편도",
    searched_date: departure_date,
    searched_date_korean: formatDateKorean(departure_date),
    nearby_cheaper: [],
  };
}

// ─── 유틸리티 함수들 ───

function extractCarrierCode(leg) {
  if (leg.flight_number) {
    const match = leg.flight_number.match(/^([A-Z]{2})\s?\d/);
    if (match) return match[1];
  }
  const name = (leg.airline || "").toLowerCase();
  if (name.includes("korean air") || name.includes("대한항공")) return "KE";
  if (name.includes("air premia") || name.includes("에어프레미아")) return "YP";
  if (name.includes("asiana") || name.includes("아시아나")) return "OZ";
  if (name.includes("american")) return "AA";
  if (name.includes("united")) return "UA";
  if (name.includes("delta")) return "DL";
  return leg.airline || "??";
}

function generateBookingUrl(airlineCode, origin, destination, date) {
  switch (airlineCode) {
    case "KE":
      return `https://www.koreanair.com/booking/best-prices?departureCode=${origin}&arrivalCode=${destination}&departureDate=${date}`;
    case "YP":
      return `https://www.airpremia.com/booking?dep=${origin}&arr=${destination}&date=${date}`;
    default:
      return `https://www.google.com/travel/flights?q=${origin}+to+${destination}+${date}`;
  }
}

/**
 * 기준 날짜 전후 N일의 날짜 목록 생성
 */
function getNearbyDates(dateStr, days) {
  const dates = [];
  const base = new Date(dateStr + "T00:00:00");

  for (let i = -days; i <= days; i++) {
    const d = new Date(base);
    d.setDate(d.getDate() + i);
    // 과거 날짜 제외
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (d >= today) {
      dates.push(d.toISOString().split("T")[0]);
    }
  }

  return dates;
}

/**
 * 날짜를 한국어로 포맷 (2026-04-15 → "4월 15일")
 */
function formatDateKorean(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

/**
 * 두 시간 문자열 사이의 분 차이 계산
 * (SerpAPI: "2026-04-15 14:30" 형식)
 */
function calcMinutesBetween(time1, time2) {
  try {
    const d1 = new Date(time1.replace(" ", "T"));
    const d2 = new Date(time2.replace(" ", "T"));
    return Math.round((d2 - d1) / 60000);
  } catch {
    return 0;
  }
}
