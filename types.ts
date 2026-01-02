
export interface TimeData {
  standard: string;
  decimalHours: number;
  frenchDecimal: string;
  timestamp: number;
}

export enum TimeMode {
  DECIMAL_HOURS = 'DECIMAL_HOURS',
  FRENCH_DECIMAL = 'FRENCH_DECIMAL'
}

export interface ConversionResult {
  hours: number;
  minutes: number;
  seconds: number;
  decimal: number;
}
