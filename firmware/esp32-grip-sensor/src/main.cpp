// ═════════════════════════════════════════════════════════════════════════════
// ReGrip ESP32 Grip Sensor Firmware  (하드웨어 실기 검증 전 / pre-hardware)
//
// FSR 악력 센서를 읽어 로컬 WiFi WebSocket 서버(포트 8080)로 20Hz JSON 브로드캐스트.
//   프론트 계약:  { "force": 73.5, "timestamp": 1717648200000 }
//   - force     : 0~100 float (원시 스케일 — 캘리브레이션은 웹앱이 수행)
//   - timestamp : millis() (부팅 후 경과 ms; 프론트 SensorService 는 force 만 사용)
//
// 전송 정책 근거: docs/backend/04-sensor-data-policy.md  ADR-04-0 (WiFi WebSocket 우선)
// 수신 계약(브라우저): shared.js  SensorService.connect('ws://<esp32-ip>:8080')
//
// 라이브러리: links2004/arduinoWebSockets (Markus Sattler) v2  — WebSocketsServer
// ═════════════════════════════════════════════════════════════════════════════
#include <Arduino.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <WebSocketsServer.h>

// ── 로컬 설정(WiFi 자격증명 등) ──────────────────────────────────────────────
// include/config.h.example 을 include/config.h 로 복사해서 값을 채우세요.
#if __has_include("config.h")
  #include "config.h"
#else
  #error "config.h 를 찾을 수 없습니다. include/config.h.example 을 include/config.h 로 복사한 뒤 WIFI_SSID/WIFI_PASS 를 채우세요."
#endif

// config.h 에 일부 항목이 빠져 있어도 빌드되도록 안전한 기본값 제공
// (WIFI_SSID / WIFI_PASS 는 필수 — 없으면 컴파일 에러로 드러납니다)
#ifndef WS_PORT
  #define WS_PORT     8080
#endif
#ifndef SAMPLE_HZ
  #define SAMPLE_HZ   20
#endif
#ifndef FSR_PIN
  #define FSR_PIN     34
#endif
#ifndef DEBUG_FORCE
  #define DEBUG_FORCE 1
#endif

// ── SoftAP 폴백(공유기 없는 환경) ────────────────────────────────────────────
// STA 접속 실패 시 ESP32 가 직접 AP 가 됩니다. 기본 IP 는 192.168.4.1.
#define AP_SSID     "ReGrip-Sensor"
#define AP_PASS     "regrip1234"

// ── 온보드 LED (대부분의 ESP32 DevKit 은 GPIO2) ──────────────────────────────
#define LED_PIN     2

// ── mDNS 호스트명 → regrip-sensor.local ──────────────────────────────────────
#define MDNS_HOST   "regrip-sensor"

// ── WiFi STA 접속 파라미터 ───────────────────────────────────────────────────
static const unsigned long STA_TIMEOUT_MS   = 15000UL;  // 15초 타임아웃
static const int           STA_MAX_ATTEMPTS = 2;        // 재시도 횟수

// ═════════════════════════════════════════════════════════════════════════════
// 전역 상태
// ═════════════════════════════════════════════════════════════════════════════
WebSocketsServer webSocket(WS_PORT);

// ── 5샘플 이동평균 스무딩(원형 버퍼) ──
static const int SMOOTH_N = 5;
static int   smoothBuf[SMOOTH_N];   // static → 0 으로 초기화됨
static int   smoothIdx   = 0;
static long  smoothSum   = 0;
static int   smoothCount = 0;       // 버퍼가 찰 때까지 SMOOTH_N 까지 증가

// ── 타이밍(millis 기반 — 메인 루프에 delay 없음) ──
static const unsigned long SAMPLE_INTERVAL_MS = 1000UL / SAMPLE_HZ;  // 20Hz → 50ms
static unsigned long lastSampleMs = 0;
static unsigned long lastDebugMs  = 0;
static unsigned long lastLedMs    = 0;

// ── LED / 연결 상태 ──
static bool  ledOn     = false;
static bool  apMode    = false;     // true = SoftAP 폴백 활성
static float lastForce = 0.0f;      // 디버그 출력용 최신 force

// ═════════════════════════════════════════════════════════════════════════════
// WebSocket 이벤트 핸들러 — links2004 v2 콜백 시그니처
//   void (uint8_t num, WStype_t type, uint8_t * payload, size_t length)
// ═════════════════════════════════════════════════════════════════════════════
void onWsEvent(uint8_t num, WStype_t type, uint8_t * payload, size_t length) {
  (void) payload;  // 프론트는 데이터를 보내지 않음 — 미사용 경고 억제
  switch (type) {
    case WStype_CONNECTED: {
      IPAddress ip = webSocket.remoteIP(num);
      Serial.printf("[WS] 클라이언트 #%u 연결됨 — %u.%u.%u.%u\n",
                    num, ip[0], ip[1], ip[2], ip[3]);
      break;
    }
    case WStype_DISCONNECTED:
      Serial.printf("[WS] 클라이언트 #%u 연결 해제\n", num);
      break;
    case WStype_TEXT:
      // 프론트가 보내지는 않지만 수신 시 기록(디버깅용)
      Serial.printf("[WS] #%u 텍스트 수신 (%u bytes)\n", num, (unsigned) length);
      break;
    default:
      break;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// WiFi STA 접속 시도(15초 타임아웃). 접속 중에는 LED 느린 점멸(500ms).
//   ※ 여기의 delay(10) 은 setup 단계 한정 — 메인 루프는 delay 없이 millis 기반.
// ═════════════════════════════════════════════════════════════════════════════
bool connectWiFiSTA() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  unsigned long start     = millis();
  unsigned long ledToggle = 0;
  bool          led       = false;

  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - start > STA_TIMEOUT_MS) {
      Serial.println();
      Serial.println("[WiFi] STA 접속 실패 (15초 타임아웃)");
      return false;
    }
    if (millis() - ledToggle > 500) {   // 느린 점멸 = WiFi 연결 중
      ledToggle = millis();
      led = !led;
      digitalWrite(LED_PIN, led ? HIGH : LOW);
    }
    delay(10);   // setup 한정: WiFi 스택/RTOS 에 양보
  }

  Serial.println();
  Serial.print("[WiFi] STA 접속 성공. IP: ");
  Serial.println(WiFi.localIP());
  return true;
}

// ═════════════════════════════════════════════════════════════════════════════
// SoftAP 폴백 시작 (공유기 없는 환경)
// ═════════════════════════════════════════════════════════════════════════════
void startSoftAP() {
  Serial.println("[WiFi] SoftAP 폴백 모드로 전환합니다.");
  WiFi.mode(WIFI_AP);
  bool ok = WiFi.softAP(AP_SSID, AP_PASS);
  if (ok) {
    Serial.printf("[WiFi] SoftAP 시작: SSID=\"%s\"  PASS=\"%s\"\n", AP_SSID, AP_PASS);
    Serial.print("[WiFi] SoftAP IP: ");
    Serial.println(WiFi.softAPIP());   // 기본값 192.168.4.1
  } else {
    Serial.println("[WiFi] SoftAP 시작 실패!");
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// mDNS 등록 → regrip-sensor.local (STA 모드에서 특히 유용)
// ═════════════════════════════════════════════════════════════════════════════
void startMDNS() {
  if (MDNS.begin(MDNS_HOST)) {
    MDNS.addService("ws", "tcp", WS_PORT);   // WebSocket 서비스 광고(선택)
    Serial.printf("[mDNS] 등록됨: ws://%s.local:%d\n", MDNS_HOST, WS_PORT);
  } else {
    Serial.println("[mDNS] 등록 실패");
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// FSR 읽기 + 5샘플 이동평균 (원형 버퍼)
//   반환: 스무딩된 원시 ADC 값 (0..4095)
// ═════════════════════════════════════════════════════════════════════════════
int readFsrSmoothed() {
  int raw = analogRead(FSR_PIN);       // 12-bit → 0..4095
  smoothSum -= smoothBuf[smoothIdx];   // 가장 오래된 샘플 제거
  smoothBuf[smoothIdx] = raw;          // 새 샘플 저장
  smoothSum += raw;
  smoothIdx = (smoothIdx + 1) % SMOOTH_N;
  if (smoothCount < SMOOTH_N) smoothCount++;   // 채워지는 동안엔 있는 샘플로 평균
  return (int) (smoothSum / smoothCount);
}

// ═════════════════════════════════════════════════════════════════════════════
// LED 상태 표시 (메인 루프용, 논블로킹)
//   클라이언트 연결됨 → 빠른 점멸(100ms) / 대기(클라이언트 0) → 켜짐
//   (WiFi 연결 중 느린 점멸은 connectWiFiSTA() 에서 처리)
// ═════════════════════════════════════════════════════════════════════════════
void updateLed(int clients) {
  unsigned long now = millis();
  if (clients > 0) {
    if (now - lastLedMs >= 100) {      // 빠른 점멸
      lastLedMs = now;
      ledOn = !ledOn;
      digitalWrite(LED_PIN, ledOn ? HIGH : LOW);
    }
  } else {
    if (!ledOn) {                       // 대기 = 켜짐(solid)
      ledOn = true;
      digitalWrite(LED_PIN, HIGH);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// setup
// ═════════════════════════════════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);
  delay(200);   // 부팅 한정: 시리얼 안정화
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  // ── 부팅 배너 ──
  Serial.println();
  Serial.println("========================================");
  Serial.println("  ReGrip ESP32 Grip Sensor Firmware");
  Serial.println("  (하드웨어 실기 검증 전 / pre-hardware)");
  Serial.println("========================================");
  Serial.printf("  WS_PORT=%d  SAMPLE_HZ=%d  FSR_PIN=%d\n", WS_PORT, SAMPLE_HZ, FSR_PIN);

  // ── ADC 설정 ──
  analogReadResolution(12);                     // 0..4095 (12-bit)
  analogSetPinAttenuation(FSR_PIN, ADC_11db);   // 입력 범위 ~0-3.1V (풀 스케일에 근접)

  // ── WiFi STA(재시도) → 실패 시 SoftAP 폴백 ──
  for (int attempt = 1; attempt <= STA_MAX_ATTEMPTS; attempt++) {
    Serial.printf("[WiFi] STA 접속 시도 %d/%d — SSID \"%s\"\n",
                  attempt, STA_MAX_ATTEMPTS, WIFI_SSID);
    if (connectWiFiSTA()) break;
  }
  if (WiFi.status() != WL_CONNECTED) {
    startSoftAP();
    apMode = true;
  }

  // ── mDNS ──
  startMDNS();

  // ── WebSocket 서버 시작 ──
  webSocket.begin();
  webSocket.onEvent(onWsEvent);

  // ── 접속 안내(브라우저에서 사용할 주소) ──
  IPAddress ip = apMode ? WiFi.softAPIP() : WiFi.localIP();
  Serial.println("----------------------------------------");
  Serial.print("[APP] 브라우저 콘솔/설정에 입력:\n      SensorService.connect('ws://");
  Serial.print(ip);
  Serial.printf(":%d')\n", WS_PORT);
  Serial.printf("[APP] 또는 mDNS: ws://%s.local:%d\n", MDNS_HOST, WS_PORT);
  if (apMode) {
    Serial.printf("[APP] SoftAP 모드 — 먼저 WiFi \"%s\"(암호 %s)에 접속하세요.\n",
                  AP_SSID, AP_PASS);
  }
  Serial.println("----------------------------------------");

  // 대기 상태 = LED 켜짐
  digitalWrite(LED_PIN, HIGH);
  ledOn = true;
}

// ═════════════════════════════════════════════════════════════════════════════
// loop — 20Hz 논블로킹. webSocket.loop() 를 매 반복 호출(굶기지 않음).
// ═════════════════════════════════════════════════════════════════════════════
void loop() {
  webSocket.loop();   // 반드시 매 반복 실행 — 절대 굶기지 않기

  unsigned long now     = millis();
  int           clients = webSocket.connectedClients();

  // ── 20Hz 샘플 & 브로드캐스트 ──
  if (now - lastSampleMs >= SAMPLE_INTERVAL_MS) {
    lastSampleMs = now;

    int   smoothed = readFsrSmoothed();
    float force    = smoothed / 4095.0f * 100.0f;   // 원시 스케일 0~100
    lastForce      = force;

    // 클라이언트가 0명이면 브로드캐스트 생략
    if (clients > 0) {
      char buf[64];
      // 프론트 계약: {"force":73.5,"timestamp":123456}  (소수 1자리, timestamp=millis())
      snprintf(buf, sizeof(buf),
               "{\"force\":%.1f,\"timestamp\":%lu}", force, now);
      webSocket.broadcastTXT(buf);
    }
  }

  // ── LED 상태 ──
  updateLed(clients);

  // ── 1초마다 force 디버그(옵션) ──
#if DEBUG_FORCE
  if (now - lastDebugMs >= 1000) {
    lastDebugMs = now;
    Serial.printf("[FSR] force=%.1f%%  clients=%d\n", lastForce, clients);
  }
#endif
}
