#include <Arduino.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>

// Re:Grip Sensor PCB Rev B2/B3
// J1-6 thumb, J1-5 index, J1-4 middle, J1-3 ring, J1-2 little,
// J1-1 common GND. Each ADC node is pulled up to 3.3 V through 47 kOhm.
constexpr uint8_t FLEX_PINS[] = {D0, D1, D2, D3, D4};
constexpr uint8_t FLEX_COUNT = sizeof(FLEX_PINS) / sizeof(FLEX_PINS[0]);
constexpr uint8_t OVERSAMPLE_COUNT = 4;
constexpr uint32_t SAMPLE_INTERVAL_US = 10000;  // 100 samples/s
constexpr uint32_t BLE_NOTIFY_INTERVAL_MS = 10; // 100 notifications/s
constexpr uint16_t DISCONNECTED_THRESHOLD = 4090;

constexpr char BLE_DEVICE_NAME[] = "ReGrip-5CH";
constexpr char BLE_SERVICE_UUID[] = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
constexpr char BLE_TX_UUID[] = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

struct SensorFrame {
  uint32_t sampleId;
  uint32_t timestampMs;
  uint16_t raw[FLEX_COUNT];
};

uint32_t nextSampleAtUs = 0;
uint32_t sampleId = 0;
uint32_t nextBleNotifyAtMs = 0;
BLECharacteristic *bleTxCharacteristic = nullptr;
volatile bool bleConnected = false;

void writeUint16LE(uint8_t *destination, uint16_t value) {
  destination[0] = static_cast<uint8_t>(value & 0xff);
  destination[1] = static_cast<uint8_t>((value >> 8) & 0xff);
}

void writeUint32LE(uint8_t *destination, uint32_t value) {
  destination[0] = static_cast<uint8_t>(value & 0xff);
  destination[1] = static_cast<uint8_t>((value >> 8) & 0xff);
  destination[2] = static_cast<uint8_t>((value >> 16) & 0xff);
  destination[3] = static_cast<uint8_t>((value >> 24) & 0xff);
}

class ReGripServerCallbacks final : public BLEServerCallbacks {
  void onConnect(BLEServer *) override {
    bleConnected = true;
    Serial.println("# BLE_CONNECTED");
  }

#if defined(CONFIG_BLUEDROID_ENABLED)
  void onConnect(BLEServer *server, esp_ble_gatts_cb_param_t *param) override {
    // Ask the Windows/browser central for a low-latency 7.5-15 ms interval.
    // The central makes the final decision, so 100 Hz is a target rather than
    // a hard real-time guarantee.
    const bool requested = server->requestConnParams(
      param->connect.remote_bda,
      6,   // 6 * 1.25 ms = 7.5 ms
      12,  // 12 * 1.25 ms = 15 ms
      0,   // no slave latency
      400  // 4 s supervision timeout
    );
    Serial.printf("# BLE_LOW_LATENCY_REQUEST,%s\n", requested ? "OK" : "FAILED");
  }
#endif

  void onDisconnect(BLEServer *server) override {
    bleConnected = false;
    Serial.println("# BLE_DISCONNECTED");
    server->getAdvertising()->start();
  }
};

void setupBle() {
  BLEDevice::init(BLE_DEVICE_NAME);
  BLEServer *server = BLEDevice::createServer();
  server->setCallbacks(new ReGripServerCallbacks());
  BLEService *service = server->createService(BLE_SERVICE_UUID);
  bleTxCharacteristic = service->createCharacteristic(
    BLE_TX_UUID,
    BLECharacteristic::PROPERTY_NOTIFY
  );
  bleTxCharacteristic->addDescriptor(new BLE2902());
  service->start();

  BLEAdvertising *advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(BLE_SERVICE_UUID);
  advertising->setScanResponse(true);
  advertising->start();
  Serial.println("# BLE_READY,ReGrip-5CH,protocol_v3,100Hz");
}

uint16_t readAdcStable(uint8_t pin) {
  // Discard the first conversion after switching ADC channels.
  analogRead(pin);
  delayMicroseconds(80);

  uint32_t sum = 0;
  for (uint8_t i = 0; i < OVERSAMPLE_COUNT; ++i) {
    sum += analogRead(pin);
    delayMicroseconds(20);
  }
  return static_cast<uint16_t>(sum / OVERSAMPLE_COUNT);
}

SensorFrame readSensors() {
  SensorFrame frame{};
  frame.sampleId = sampleId++;
  frame.timestampMs = millis();
  for (uint8_t i = 0; i < FLEX_COUNT; ++i) {
    frame.raw[i] = readAdcStable(FLEX_PINS[i]);
  }
  return frame;
}

void printCsv(const SensorFrame &frame) {
  Serial.printf(
    "%lu,%lu,%u,%u,%u,%u,%u\n",
    static_cast<unsigned long>(frame.sampleId),
    static_cast<unsigned long>(frame.timestampMs),
    frame.raw[0], frame.raw[1], frame.raw[2], frame.raw[3], frame.raw[4]
  );
}

void notifyBle(const SensorFrame &frame) {
  if (!bleConnected || bleTxCharacteristic == nullptr) return;

  // Protocol v3, 20-byte payload (fits the default BLE ATT notification):
  // magic, version, sequence, timestamp, five uint16 ADC values,
  // connected-channel bit mask, error code.
  uint8_t packet[20] = {};
  packet[0] = 0x52;  // 'R'
  packet[1] = 3;
  writeUint16LE(packet + 2, static_cast<uint16_t>(frame.sampleId & 0xffff));
  writeUint32LE(packet + 4, frame.timestampMs);

  uint8_t connectedMask = 0;
  for (uint8_t i = 0; i < FLEX_COUNT; ++i) {
    writeUint16LE(packet + 8 + i * 2, frame.raw[i]);
    if (frame.raw[i] < DISCONNECTED_THRESHOLD) connectedMask |= 1U << i;
  }
  packet[18] = connectedMask;
  packet[19] = 0;  // reserved error code

  bleTxCharacteristic->setValue(packet, sizeof(packet));
  bleTxCharacteristic->notify();
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  analogReadResolution(12);  // 0..4095
  for (uint8_t i = 0; i < FLEX_COUNT; ++i) {
    pinMode(FLEX_PINS[i], INPUT);
    analogSetPinAttenuation(FLEX_PINS[i], ADC_11db);
  }

  Serial.println("sample_id,timestamp_ms,thumb_raw,index_raw,middle_raw,ring_raw,little_raw");
  setupBle();
  Serial.println("# READY,ReGrip Sensor PCB 5ch,USB_100Hz,BLE_100Hz");
  nextSampleAtUs = micros();
  nextBleNotifyAtMs = millis();
}

void loop() {
  const uint32_t nowUs = micros();
  if (static_cast<int32_t>(nowUs - nextSampleAtUs) < 0) return;

  nextSampleAtUs += SAMPLE_INTERVAL_US;
  const SensorFrame frame = readSensors();
  printCsv(frame);

  if (static_cast<int32_t>(frame.timestampMs - nextBleNotifyAtMs) >= 0) {
    nextBleNotifyAtMs += BLE_NOTIFY_INTERVAL_MS;
    notifyBle(frame);
  }

  // If serial transmission or another task delayed us by more than one period,
  // skip the backlog instead of emitting a burst of old samples.
  const uint32_t afterReadUs = micros();
  if (static_cast<int32_t>(afterReadUs - nextSampleAtUs) >=
      static_cast<int32_t>(SAMPLE_INTERVAL_US)) {
    nextSampleAtUs = afterReadUs + SAMPLE_INTERVAL_US;
  }
}
