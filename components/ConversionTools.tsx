
import React, { useState, useEffect } from 'react';
import { toDecimalHours, fromDecimalHours, formatTwoDigits } from '../utils/timeUtils';

const ConversionTools: React.FC = () => {
  const [stdH, setStdH] = useState<string>('08');
  const [stdM, setStdM] = useState<string>('30');
  const [stdS, setStdS] = useState<string>('00');
  const [decimalVal, setDecimalVal] = useState<string>('8.5');

  const handleStdChange = (type: 'h'|'m'|'s', val: string) => {
    const num = parseInt(val) || 0;
    if (type === 'h' && num > 23) return;
    if ((type === 'm' || type === 's') && num > 59) return;
    
    let newH = stdH, newM = stdM, newS = stdS;
    if (type === 'h') { newH = val; setStdH(val); }
    if (type === 'm') { newM = val; setStdM(val); }
    if (type === 's') { newS = val; setStdS(val); }

    const dec = toDecimalHours(parseInt(newH) || 0, parseInt(newM) || 0, parseInt(newS) || 0);
    setDecimalVal(dec.toFixed(4).replace(/\.?0+$/, ''));
  };

  const handleDecChange = (val: string) => {
    setDecimalVal(val);
    const num = parseFloat(val);
    if (!isNaN(num) && num >= 0 && num < 24) {
      const { h, m, s } = fromDecimalHours(num);
      setStdH(formatTwoDigits(h));
      setStdM(formatTwoDigits(m));
      setStdS(formatTwoDigits(s));
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div className="glass rounded-3xl p-8 space-y-6">
        <h3 className="text-xl font-semibold flex items-center gap-2">
          <svg className="w-5 h-5 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          Standard to Decimal
        </h3>
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <label className="text-xs text-slate-500 mb-1 block">Hours</label>
            <input 
              type="number" 
              value={stdH} 
              onChange={(e) => handleStdChange('h', e.target.value)}
              className="w-full bg-slate-800/50 border border-slate-700 rounded-xl px-4 py-3 mono focus:outline-none focus:ring-2 focus:ring-indigo-500/50 transition-all"
            />
          </div>
          <span className="mt-6 font-bold text-slate-600">:</span>
          <div className="flex-1">
            <label className="text-xs text-slate-500 mb-1 block">Minutes</label>
            <input 
              type="number" 
              value={stdM} 
              onChange={(e) => handleStdChange('m', e.target.value)}
              className="w-full bg-slate-800/50 border border-slate-700 rounded-xl px-4 py-3 mono focus:outline-none focus:ring-2 focus:ring-indigo-500/50 transition-all"
            />
          </div>
          <span className="mt-6 font-bold text-slate-600">:</span>
          <div className="flex-1">
            <label className="text-xs text-slate-500 mb-1 block">Seconds</label>
            <input 
              type="number" 
              value={stdS} 
              onChange={(e) => handleStdChange('s', e.target.value)}
              className="w-full bg-slate-800/50 border border-slate-700 rounded-xl px-4 py-3 mono focus:outline-none focus:ring-2 focus:ring-indigo-500/50 transition-all"
            />
          </div>
        </div>
      </div>

      <div className="glass rounded-3xl p-8 space-y-6">
        <h3 className="text-xl font-semibold flex items-center gap-2">
          <svg className="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
          Decimal Hours
        </h3>
        <div>
          <label className="text-xs text-slate-500 mb-1 block">Decimal Value (0.00 - 23.99)</label>
          <div className="relative">
            <input 
              type="number" 
              step="0.01"
              value={decimalVal} 
              onChange={(e) => handleDecChange(e.target.value)}
              className="w-full bg-slate-800/50 border border-slate-700 rounded-xl px-4 py-3 mono text-2xl font-bold text-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all"
            />
            <div className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500 font-bold">h</div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ConversionTools;
