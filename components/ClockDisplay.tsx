
import React from 'react';

interface ClockDisplayProps {
  label: string;
  time: string;
  subValue?: string;
  colorClass?: string;
}

const ClockDisplay: React.FC<ClockDisplayProps> = ({ label, time, subValue, colorClass = "text-indigo-400" }) => {
  return (
    <div className="glass rounded-3xl p-6 md:p-8 flex flex-col items-center justify-center transition-all duration-300 hover:scale-[1.02] shadow-xl">
      <span className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-2">{label}</span>
      <div className={`mono text-4xl md:text-6xl font-bold ${colorClass} tracking-tighter tabular-nums`}>
        {time}
      </div>
      {subValue && (
        <div className="mt-2 text-slate-500 text-sm mono">
          {subValue}
        </div>
      )}
    </div>
  );
};

export default ClockDisplay;
