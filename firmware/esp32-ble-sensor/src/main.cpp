#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// GPIO35 is currently a potentiometer, not a physical flex sensor.
constexpr uint8_t FLEX_PIN = 35;
constexpr uint8_t FSR_PIN = 34;
constexpr uint32_t SAMPLE_INTERVAL_US = 20000; // 50 Hz sampling
constexpr uint32_t BLE_INTERVAL_MS = 50;      // latest sample at 20 Hz
constexpr char DEVICE_NAME[] = "ReGrip-Sensor";
constexpr char SERVICE_UUID[] = "6E400001-B5A3-F393-E0A9-E50E24DCCA9E";
constexpr char TX_UUID[] = "6E400003-B5A3-F393-E0A9-E50E24DCCA9E";

BLEServer *bleServer = nullptr;
BLECharacteristic *txCharacteristic = nullptr;
volatile bool deviceConnected = false;
volatile bool restartAdvertisingPending = false;
volatile uint32_t disconnectedAtMs = 0;
uint32_t nextSampleUs = 0, lastBleMs = 0, sampleTimestampMs = 0;
uint32_t sampleId = 0;
uint16_t flexRaw = 0, fsrRaw = 0;
bool hasSample = false;

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *) override {
    deviceConnected = true;
    restartAdvertisingPending = false;
    Serial.println("# BLE connected");
  }
  void onDisconnect(BLEServer *) override {
    deviceConnected = false;
    disconnectedAtMs = millis();
    restartAdvertisingPending = true;
    Serial.println("# BLE disconnected");
  }
};

uint16_t readAdcStable(uint8_t pin) {
  analogRead(pin); // discard the first conversion after switching channels
  delayMicroseconds(50);
  return static_cast<uint16_t>(analogRead(pin));
}

void sampleSensors() {
  sampleTimestampMs = millis();
  flexRaw = readAdcStable(FLEX_PIN);
  fsrRaw = readAdcStable(FSR_PIN);
  hasSample = true;
  // Preserve the USB capture format used by the original 50 Hz measurements.
  // BLE deliberately omits sample_id to fit the default 20-byte ATT payload.
  Serial.printf("%lu,%lu,%u,%u\n", static_cast<unsigned long>(sampleId++),
      static_cast<unsigned long>(sampleTimestampMs), flexRaw, fsrRaw);
}

void sendBleNotification() {
  // Max uint32 timestamp + two ADC12 values: "4294967295,4095,4095" = 20 bytes.
  // No newline/NUL is transmitted, so the default ATT MTU of 23 is sufficient.
  char packet[24];
  const int length = snprintf(packet, sizeof(packet), "%lu,%u,%u",
      static_cast<unsigned long>(sampleTimestampMs), flexRaw, fsrRaw);
  if (length <= 0 || length > 20 || length >= static_cast<int>(sizeof(packet))) return;
  txCharacteristic->setValue(reinterpret_cast<uint8_t *>(packet), static_cast<size_t>(length));
  txCharacteristic->notify();
}

void setup() {
  Serial.begin(115200);
  pinMode(FLEX_PIN, INPUT);
  pinMode(FSR_PIN, INPUT);
  analogReadResolution(12);
  analogSetPinAttenuation(FLEX_PIN, ADC_11db);
  analogSetPinAttenuation(FSR_PIN, ADC_11db);

  BLEDevice::init(DEVICE_NAME);
  bleServer = BLEDevice::createServer();
  bleServer->setCallbacks(new ServerCallbacks());
  BLEService *service = bleServer->createService(SERVICE_UUID);
  txCharacteristic = service->createCharacteristic(TX_UUID,
      BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  txCharacteristic->addDescriptor(new BLE2902());
  txCharacteristic->setValue("0,0,0");
  service->start();
  BLEAdvertising *advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(SERVICE_UUID);
  advertising->setScanResponse(true);
  BLEDevice::startAdvertising();

  Serial.println("# ReGrip BLE sensor v2 ready: USB 50 Hz, BLE 20 Hz");
  Serial.println("# GPIO35 potentiometer (flex simulation), GPIO34 pressure");
  Serial.println("sample_id,timestamp_ms,flex_raw,fsr_raw");
  nextSampleUs = micros();
  lastBleMs = millis();
}

void loop() {
  const uint32_t beforeSampleUs = micros();
  if (static_cast<int32_t>(beforeSampleUs - nextSampleUs) >= 0) {
    nextSampleUs += SAMPLE_INTERVAL_US;
    sampleSensors();
    // Check the time AFTER ADC + serial work; never emit catch-up sample bursts.
    const uint32_t afterSampleUs = micros();
    if (static_cast<int32_t>(afterSampleUs - nextSampleUs) >= 0) {
      nextSampleUs = afterSampleUs + SAMPLE_INTERVAL_US;
    }
  }

  const uint32_t nowMs = millis();
  if (deviceConnected && hasSample && static_cast<uint32_t>(nowMs - lastBleMs) >= BLE_INTERVAL_MS) {
    lastBleMs = nowMs;
    sendBleNotification();
  }
  if (restartAdvertisingPending && !deviceConnected && static_cast<uint32_t>(nowMs - disconnectedAtMs) >= 500) {
    restartAdvertisingPending = false;
    bleServer->startAdvertising();
    Serial.println("# BLE advertising restarted");
  }
}
