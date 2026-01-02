
import React, { useState, useEffect, useMemo } from 'react';

// --- Lightweight UI Components ---

const Slider = ({ value, min = 0, max, onValueChange }: { value: number, min?: number, max: number, onValueChange: (v: number) => void }) => (
  <input 
    type="range" 
    min={min} 
    max={max} 
    value={value} 
    onChange={(e) => onValueChange(parseInt(e.target.value))}
    className="w-full cursor-pointer accent-purple-600"
  />
);

const Button = ({ children, onClick, className = "", variant = "primary", disabled = false }: any) => {
  const base = "px-6 py-2.5 rounded-xl font-semibold transition-all active:scale-95 disabled:opacity-40 flex items-center justify-center gap-2";
  const styles: any = {
    primary: "bg-purple-600 text-white hover:bg-purple-700 shadow-md",
    secondary: "bg-gray-200 text-gray-800 hover:bg-gray-300",
    ghost: "text-gray-600 hover:bg-gray-100"
  };
  return (
    <button disabled={disabled} onClick={onClick} className={`${base} ${styles[variant]} ${className}`}>
      {children}
    </button>
  );
};

// --- Main App Logic ---

interface TimeObject {
  hours: number;
  minutes: number;
  period: 'AM' | 'PM';
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'hours' | 'times'>('hours');
  
  // Hours to Decimal state
  const [hours, setHours] = useState(0);
  const [minutes, setMinutes] = useState(0);
  
  // Times to Decimal state
  const [startTime, setStartTime] = useState<TimeObject | null>(null);
  const [endTime, setEndTime] = useState<TimeObject | null>(null);
  
  // Time picker state
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [editingTimeSlot, setEditingTimeSlot] = useState<'start' | 'end' | null>(null);
  const [inputDigits, setInputDigits] = useState('');
  const [selectedPeriod, setSelectedPeriod] = useState<'AM' | 'PM' | null>(null);

  // --- Calculations ---

  const decimalFromSliders = useMemo(() => {
    return (hours + minutes / 60).toFixed(2);
  }, [hours, minutes]);

  const decimalFromDifference = useMemo(() => {
    if (!startTime || !endTime) return "0.00";
    
    const to24 = (t: TimeObject) => {
      let h = t.hours;
      if (t.period === 'PM' && h !== 12) h += 12;
      if (t.period === 'AM' && h === 12) h = 0;
      return h * 60 + t.minutes;
    };

    let startTotal = to24(startTime);
    let endTotal = to24(endTime);
    
    if (endTotal < startTotal) endTotal += 24 * 60; // Crosses midnight
    
    return ((endTotal - startTotal) / 60).toFixed(2);
  }, [startTime, endTime]);

  // --- Time Picker Handlers ---

  const handleDigit = (d: string) => {
    if (inputDigits.length < 4) setInputDigits(p => p + d);
  };

  const parseInput = () => {
    const d = inputDigits.padStart(1, '0');
    let h = 0, m = 0;
    if (d.length <= 2) {
      h = parseInt(d) || 0;
    } else if (d.length === 3) {
      h = parseInt(d[0]);
      m = parseInt(d.slice(1));
    } else {
      h = parseInt(d.slice(0, 2));
      m = parseInt(d.slice(2));
    }
    // Validation constraints
    if (h > 12) h = 12;
    if (h === 0 && d.length >= 1) h = 12;
    if (m > 59) m = 59;
    return { h, m };
  };

  const getDisplayTime = () => {
    if (inputDigits.length === 0) return "__:__";
    const { h, m } = parseInput();
    if (inputDigits.length === 1) return `${inputDigits}:__`;
    if (inputDigits.length === 2) return `${inputDigits[0]}:${inputDigits[1]}_`;
    if (inputDigits.length === 3) return `${h}:${m.toString().padStart(2, '0')}`;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
  };

  const confirmTime = () => {
    if (inputDigits.length === 0 || !selectedPeriod) return;
    const { h, m } = parseInput();
    const timeObj: TimeObject = { hours: h, minutes: m, period: selectedPeriod };
    if (editingTimeSlot === 'start') setStartTime(timeObj);
    else setEndTime(timeObj);
    closePicker();
  };

  const closePicker = () => {
    setIsPickerOpen(false);
    setInputDigits('');
    setSelectedPeriod(null);
  };

  const formatTime = (t: TimeObject | null) => t ? `${t.hours}:${t.minutes.toString().padStart(2, '0')} ${t.period}` : "Set";

  return (
    <div className="flex flex-col min-h-screen max-w-md mx-auto bg-gray-50 shadow-2xl relative overflow-hidden border-x border-gray-200">
      {/* Header */}
      <header className="bg-purple-600 text-white p-5 flex items-center gap-3 shadow-lg z-10">
        <svg className="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
        <h1 className="text-xl font-bold tracking-tight">Decimal Converter</h1>
      </header>

      {/* Tabs */}
      <nav className="flex bg-white border-b-2 border-purple-600 relative z-10">
        <button 
          onClick={() => setActiveTab('hours')}
          className={`flex-1 py-4 text-xs font-bold uppercase tracking-widest transition-all ${activeTab === 'hours' ? 'text-purple-700' : 'text-gray-400'}`}
        >
          Hours to Decimal
          {activeTab === 'hours' && <div className="absolute bottom-0 h-1 bg-purple-600 w-1/2 left-0 transition-all duration-300"></div>}
        </button>
        <button 
          onClick={() => setActiveTab('times')}
          className={`flex-1 py-4 text-xs font-bold uppercase tracking-widest transition-all ${activeTab === 'times' ? 'text-purple-700' : 'text-gray-400'}`}
        >
          Times to Decimal
          {activeTab === 'times' && <div className="absolute bottom-0 h-1 bg-purple-600 w-1/2 right-0 transition-all duration-300"></div>}
        </button>
      </nav>

      {/* Content Area */}
      <main className="flex-1 p-6 flex flex-col space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
        {activeTab === 'hours' ? (
          <section className="space-y-10">
            <p className="text-gray-500 text-sm leading-relaxed">
              Adjust sliders to convert standard hours and minutes into a decimal value.
            </p>
            
            <div className="space-y-8">
              <div className="space-y-3">
                <div className="flex justify-between items-end">
                  <label className="text-xs font-bold uppercase tracking-wider text-gray-400">Hours</label>
                  <span className="text-3xl font-bold text-purple-600 mono">{hours}</span>
                </div>
                <Slider value={hours} max={23} onValueChange={setHours} />
              </div>

              <div className="space-y-3">
                <div className="flex justify-between items-end">
                  <label className="text-xs font-bold uppercase tracking-wider text-gray-400">Minutes</label>
                  <span className="text-3xl font-bold text-purple-600 mono">{minutes}</span>
                </div>
                <Slider value={minutes} max={59} onValueChange={setMinutes} />
              </div>
            </div>
          </section>
        ) : (
          <section className="space-y-10">
             <p className="text-gray-500 text-sm leading-relaxed">
              Select start and end times to calculate the decimal duration between them.
            </p>

            <div className="flex justify-around items-center gap-4">
              <div className="flex-1 text-center space-y-3">
                <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Start Time</p>
                <Button 
                  variant="secondary" 
                  className="w-full py-4 text-lg mono"
                  onClick={() => { setEditingTimeSlot('start'); setIsPickerOpen(true); }}
                >
                  {formatTime(startTime)}
                </Button>
              </div>

              <div className="text-gray-300">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14 5l7 7m0 0l-7 7m7-7H3" /></svg>
              </div>

              <div className="flex-1 text-center space-y-3">
                <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">End Time</p>
                <Button 
                  variant="secondary" 
                  className="w-full py-4 text-lg mono"
                  onClick={() => { setEditingTimeSlot('end'); setIsPickerOpen(true); }}
                >
                  {formatTime(endTime)}
                </Button>
              </div>
            </div>
          </section>
        )}

        {/* Big Result Card */}
        <div className="mt-auto pt-10 pb-6 text-center animate-in zoom-in-95 duration-700">
          <div className="inline-block relative">
            <h2 className="text-7xl font-light text-gray-900 mono tabular-nums">
              {activeTab === 'hours' ? decimalFromSliders : decimalFromDifference}
            </h2>
            <div className="absolute -right-12 bottom-4 text-purple-600 font-bold text-lg">h</div>
          </div>
          <p className="text-gray-400 uppercase tracking-[0.3em] text-[10px] font-bold mt-2">Decimal Hours</p>
        </div>
      </main>

      {/* Footer / Offline Status */}
      <footer className="p-4 bg-gray-100/50 border-t border-gray-200 text-center">
        <div className="flex items-center justify-center gap-2 text-[10px] font-bold text-gray-400 uppercase tracking-widest">
          <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]"></div>
          Offline Engine Ready
        </div>
      </footer>

      {/* Modern Time Picker Modal */}
      {isPickerOpen && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 animate-in fade-in duration-200">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={closePicker}></div>
          <div className="relative w-full max-w-sm bg-white rounded-t-[2.5rem] sm:rounded-[2rem] overflow-hidden shadow-2xl animate-in slide-in-from-bottom-full duration-300">
            {/* Modal Header/Display */}
            <div className="bg-gray-50 p-8 text-center border-b">
              <p className="text-xs font-bold text-purple-600 uppercase tracking-widest mb-4">Set {editingTimeSlot} time</p>
              <div className="flex items-center justify-center gap-3">
                <span className="text-5xl font-light text-gray-800 mono tracking-tighter tabular-nums">
                  {getDisplayTime()}
                </span>
                <span className="text-xl font-bold text-purple-600 bg-purple-50 px-3 py-1 rounded-lg">
                  {selectedPeriod || '--'}
                </span>
              </div>
            </div>

            {/* Keypad */}
            <div className="p-6 grid grid-cols-3 gap-3">
              {[1, 2, 3, 4, 5, 6, 7, 8, 9].map(num => (
                <button 
                  key={num} 
                  onClick={() => handleDigit(num.toString())}
                  className="h-14 rounded-2xl bg-gray-50 hover:bg-gray-100 active:scale-95 transition-all text-xl font-medium text-gray-700"
                >
                  {num}
                </button>
              ))}
              <button 
                onClick={() => setSelectedPeriod('AM')}
                className={`h-14 rounded-2xl font-bold text-sm transition-all ${selectedPeriod === 'AM' ? 'bg-purple-600 text-white shadow-lg' : 'bg-gray-50 text-gray-500'}`}
              >
                AM
              </button>
              <button 
                onClick={() => handleDigit('0')}
                className="h-14 rounded-2xl bg-gray-50 hover:bg-gray-100 active:scale-95 transition-all text-xl font-medium text-gray-700"
              >
                0
              </button>
              <button 
                onClick={() => setSelectedPeriod('PM')}
                className={`h-14 rounded-2xl font-bold text-sm transition-all ${selectedPeriod === 'PM' ? 'bg-purple-600 text-white shadow-lg' : 'bg-gray-50 text-gray-500'}`}
              >
                PM
              </button>
            </div>

            {/* Actions */}
            <div className="flex p-4 gap-3 border-t">
              <Button variant="ghost" className="flex-1" onClick={closePicker}>Cancel</Button>
              <Button 
                className="flex-1" 
                disabled={inputDigits.length === 0 || !selectedPeriod} 
                onClick={confirmTime}
              >
                Done
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
