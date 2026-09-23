#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// XIAO ESP32-S3: D0, D1, D3, D4, D5; D2 is deliberately not sampled.
// Thumb, index, middle, ring, little. All five pins are inputs, never outputs.
constexpr uint8_t PINS[] = {1, 2, 4, 5, 6};
constexpr char SERVICE[] = "6E400001-B5A3-F393-E0A9-E50E24DCCA9E";
constexpr char TX_UUID[] = "6E400003-B5A3-F393-E0A9-E50E24DCCA9E";
BLEServer *server = nullptr;
BLECharacteristic *tx = nullptr;
volatile bool connected = false, advertisePending = false;
volatile uint32_t disconnectedAt = 0;
uint16_t fingers[5] = {};
uint32_t sampleId = 0, sampleTime = 0, nextSample = 0, lastNotify = 0;

class Callbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *) override { connected = true; advertisePending = false; }
  void onDisconnect(BLEServer *) override {
    connected = false; disconnectedAt = millis(); advertisePending = true;
  }
};

void setup() {
  Serial.begin(115200);
  analogReadResolution(12);
  for (uint8_t pin : PINS) {
    pinMode(pin, INPUT);
    analogSetPinAttenuation(pin, ADC_11db);
  }
  BLEDevice::init("ReGrip-Sensor");
  server = BLEDevice::createServer();
  server->setCallbacks(new Callbacks());
  auto service = server->createService(SERVICE);
  tx = service->createCharacteristic(TX_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  tx->addDescriptor(new BLE2902());
  service->start();
  auto advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(SERVICE);
  advertising->setScanResponse(true);
  BLEDevice::startAdvertising();
  Serial.println("# ReGrip XIAO glove v1: thumb=D0,index=D1,middle=D3,ring=D4,little=D5; D2 unused");
  Serial.println("sample_id,timestamp_ms,thumb_raw,index_raw,middle_raw,ring_raw,little_raw");
  nextSample = micros();
}

void loop() {
  const uint32_t currentUs = micros();
  if (static_cast<int32_t>(currentUs - nextSample) >= 0) {
    nextSample += 20000;
    sampleTime = millis();
    for (size_t i = 0; i < 5; ++i) {
      analogRead(PINS[i]);
      delayMicroseconds(50);
      fingers[i] = analogRead(PINS[i]);
    }
    // USB logging must never hold up BLE when no serial reader is attached.
    if (Serial && Serial.availableForWrite() >= 64) {
      Serial.printf("%lu,%lu,%u,%u,%u,%u,%u\n", static_cast<unsigned long>(sampleId),
        static_cast<unsigned long>(sampleTime), fingers[0], fingers[1], fingers[2], fingers[3], fingers[4]);
    }
    ++sampleId;
    if (static_cast<int32_t>(micros() - nextSample) >= 0) nextSample = micros() + 20000;
  }
  const uint32_t now = millis();
  if (connected && sampleId && static_cast<uint32_t>(now - lastNotify) >= 50) {
    lastNotify = now;
    // 18 bytes fit the default ATT payload. Header RG, version 1, five channels.
    // uint32 timestamp and five uint16 ADC readings, all little-endian.
    uint8_t packet[18] = {0x52, 0x47, 1, 5};
    for (size_t b = 0; b < 4; ++b) packet[4 + b] = (sampleTime >> (8 * b)) & 0xff;
    for (size_t i = 0; i < 5; ++i) {
      packet[8 + i * 2] = fingers[i] & 0xff;
      packet[9 + i * 2] = fingers[i] >> 8;
    }
    tx->setValue(packet, sizeof(packet));
    tx->notify();
  }
  if (advertisePending && !connected && static_cast<uint32_t>(now - disconnectedAt) >= 500) {
    advertisePending = false;
    server->startAdvertising();
  }
  delay(1);
}
