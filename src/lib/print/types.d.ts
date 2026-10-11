export interface BLECharacteristic extends EventTarget {
	value?: DataView;
	properties: { writeWithoutResponse?: boolean };
	startNotifications(): Promise<BLECharacteristic>;
	writeValueWithoutResponse?(bytes: Uint8Array): Promise<void>;
	writeValue?(bytes: Uint8Array): Promise<void>;
}
export interface BLEService {
	getCharacteristic(uuid: string): Promise<BLECharacteristic>;
}
export interface BLEGatt {
	connected: boolean;
	connect(): Promise<BLEGatt>;
	disconnect(): void;
	getPrimaryService(uuid: string): Promise<BLEService>;
}
export interface BLEDevice extends EventTarget {
	id: string;
	name?: string;
	gatt: BLEGatt;
}
export interface BluetoothAPI {
	getDevices?(): Promise<BLEDevice[]>;
	requestDevice(options: { filters: { name: string }[]; optionalServices: string[] }): Promise<BLEDevice>;
}
export interface PrinterOptions {
	bluetooth?: () => BluetoothAPI | undefined;
	storage?: () => Pick<Storage, 'getItem' | 'setItem'> | undefined;
	chunkSize?: number;
	delay?: number;
	connectionTimeout?: number;
	writeTimeout?: number;
	pauseTimeout?: number;
	retryDelay?: number;
	maxJobAge?: number;
}
