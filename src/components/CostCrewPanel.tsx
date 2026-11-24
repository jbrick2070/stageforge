import React, { useEffect, useRef, useState } from 'react';
import {
  DollarSign,
  Users,
  Truck,
  Zap,
  CheckCircle2,
  ClipboardCheck,
  Clock,
} from 'lucide-react';
import type { RigConfig } from '../types/show';
import type { ProductionEstimate } from '../data/productionEstimator';
import { formatUSD } from '../data/productionEstimator';
import { EquipmentThumbnail } from './EquipmentThumbnail';

interface CostCrewPanelProps {
  rig: RigConfig;
  est: ProductionEstimate;
  onFocusSafeControl?: () => void;
  onDeployRig?: () => void;
}

export const CostCrewPanel: React.FC<CostCrewPanelProps> = ({
  rig,
  est,
  onFocusSafeControl,
  onDeployRig,
}) => {
  const [simulatingLoadIn, setSimulatingLoadIn] = useState(false);
  const [loadInStep, setLoadInStep] = useState(0);
  const [approved, setApproved] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      window.clearInterval(timer.current);
    };
  }, []);

  const steps = [
    `Unloading ${est.trucksNeeded} × 53ft semi-truck${est.trucksNeeded > 1 ? 's' : ''} (${Math.round(est.totalWeightLbs).toLocaleString()} lbs)...`,
    `High-steel riggers hoisting trusses & kinetic chain motors...`,
    rig.audioRig.lineArrays
      ? 'Flying the left and right speaker arrays…'
      : rig.audioRig.subWall
        ? `Positioning ${rig.audioRig.subCount} subwoofers…`
        : 'Checking the stage audio patch…',
    `Patching DMX Universes, LED wall processors & LSO laser clearance...`,
    `Crew call complete — SHOW READY FOR FOH!`,
  ];

  const handleSimulateLoadIn = () => {
    onFocusSafeControl?.();
    setSimulatingLoadIn(true);
    setApproved(false);
    setLoadInStep(0);
    let step = 0;
    window.clearInterval(timer.current);
    timer.current = window.setInterval(() => {
      step++;
      if (step >= steps.length) {
        window.clearInterval(timer.current);
        setSimulatingLoadIn(false);
        setApproved(true);
        onDeployRig?.();
      } else {
        setLoadInStep(step);
      }
    }, 520);
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-y-auto">
      {/* Top KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 p-4 bg-black/35 border-b border-white/10">
        <StatCard
          icon={<DollarSign className="w-4 h-4 text-rose-400" />}
          label="IF YOU BOUGHT THIS RIG"
          value={formatUSD(est.totalBuyCost)}
          sub="Real touring gear value"
          accent="text-rose-300"
        />
        <StatCard
          icon={<ClipboardCheck className="w-4 h-4 text-amber-400" />}
          label="1-NIGHT SHOW + LABOR"
          value={formatUSD(est.oneNightShowTotal)}
          sub={`Rent ${formatUSD(est.totalRentalCost)} + Crew ${formatUSD(est.totalLaborCost)}`}
          accent="text-amber-300"
        />
        <StatCard
          icon={<Users className="w-4 h-4 text-cyan-400" />}
          label="UNION CREW & TRUCKS"
          value={`${est.totalCrewHeadcount} CREW • ${est.trucksNeeded} TRUCKS`}
          sub={`~${est.loadInHours} hr arena load-in`}
          accent="text-cyan-300"
        />
        <StatCard
          icon={<Zap className="w-4 h-4 text-fuchsia-400" />}
          label="RIG WEIGHT & POWER"
          value={`${(est.totalWeightLbs / 2000).toFixed(1)} TONS`}
          sub={`${(est.totalWatts / 1000).toFixed(1)} kW (${Math.ceil(est.totalWatts / 120000)}× 400A feeds)`}
          accent="text-fuchsia-300"
        />
      </div>

      {/* Itemized Tables */}
      <div className="p-4 grid grid-cols-1 lg:grid-cols-2 gap-4 text-xs">
        {/* Equipment Table */}
        <div className="bg-black/45 border border-white/10 rounded-xl p-3">
          <div className="font-mono-tech text-[10px] tracking-widest text-cyan-400 mb-2 flex items-center justify-between">
            <span>EQUIPMENT MANIFEST</span>
            <span>BUY / 1-DAY RENT</span>
          </div>
          <div className="space-y-1.5">
            {est.equipmentItems.map((item, idx) => (
              <div
                key={idx}
                className="flex items-center justify-between gap-2 py-1.5 border-b border-white/5 last:border-0"
              >
                <div className="min-w-0 flex items-center gap-2">
                  {item.body && (
                    <EquipmentThumbnail
                      family={item.body}
                      catalogId={item.catalogId}
                      className="w-6 h-6 shrink-0 rounded bg-black/45 p-0.5 border border-white/10"
                    />
                  )}
                  <div className="min-w-0">
                    <div className="text-zinc-100 font-medium truncate">{item.label}</div>
                    <div className="font-mono-tech text-[9px] text-zinc-500">
                      {item.category} • {item.qty} • {Math.round(item.weightLbs).toLocaleString()} lbs
                    </div>
                  </div>
                </div>
                <div className="text-right font-mono-tech shrink-0">
                  <div className="text-zinc-200">{formatUSD(item.buyCost)}</div>
                  <div className="text-[10px] text-amber-300">{formatUSD(item.rentalCost)}/day</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Crew Labor & Trucking Table */}
        <div className="bg-black/45 border border-white/10 rounded-xl p-3 flex flex-col justify-between">
          <div>
            <div className="font-mono-tech text-[10px] tracking-widest text-amber-400 mb-2 flex items-center justify-between">
              <span>STAGEHAND &amp; TECHNICAL CREW LABOR ESTIMATE</span>
              <span>CALL COST</span>
            </div>
            <div className="space-y-1.5">
              {est.laborItems.map((l, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between gap-2 py-1.5 border-b border-white/5"
                >
                  <div className="min-w-0">
                    <div className="text-zinc-100 font-medium">{l.role}</div>
                    <div className="font-mono-tech text-[9px] text-zinc-500 flex items-center gap-2">
                      <span>{l.crewCount} tech{l.crewCount > 1 ? 's' : ''}</span>
                      <span>• {l.hours}h call</span>
                      <span>• ${l.ratePerHr}/hr</span>
                    </div>
                  </div>
                  <div className="font-mono-tech text-amber-300 font-semibold shrink-0">
                    {formatUSD(l.total)}
                  </div>
                </div>
              ))}
              <div className="flex items-center justify-between gap-2 py-1.5">
                <div className="flex items-center gap-1.5 text-zinc-100 font-medium">
                  <Truck className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                  <span>53ft Production Semi-Trucks &amp; Drivers ({est.trucksNeeded} trucks)</span>
                </div>
                <div className="font-mono-tech text-amber-300 font-semibold shrink-0">
                  {formatUSD(est.truckingCost)}
                </div>
              </div>
            </div>
          </div>

          {/* Simulated Virtual Load-In Status */}
          <div className="mt-4 pt-3 border-t border-white/10">
            {simulatingLoadIn && (
              <div className="mb-2.5 p-2.5 rounded-lg bg-cyan-950/60 border border-cyan-400/50 font-mono-tech text-[11px] text-cyan-200 flex items-center gap-2">
                <Clock className="w-4 h-4 animate-spin motion-reduce:animate-none shrink-0 text-cyan-400" />
                <span>{steps[loadInStep]}</span>
              </div>
            )}
            {approved && !simulatingLoadIn && (
              <div className="mb-2.5 p-2.5 rounded-lg bg-emerald-950/60 border border-emerald-400/50 font-mono-tech text-[11px] text-emerald-200 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
                <span>VIRTUAL WORK ORDER APPROVED ($0.00) — FULL CREW LOAD-IN COMPLETE!</span>
              </div>
            )}

            <div className="rounded-xl bg-gradient-to-r from-emerald-950/80 to-cyan-950/70 border border-emerald-400/40 p-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="font-mono-tech text-[10px] text-emerald-300 tracking-wider">
                  YOUR COST IN STAGEFORGE 3D
                </div>
                <div className="font-display font-bold text-xl text-white">
                  $0.00{' '}
                  <span className="text-xs font-mono-tech text-emerald-300 font-normal">
                    (SAVED {formatUSD(est.oneNightShowTotal)} TONIGHT!)
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={handleSimulateLoadIn}
                disabled={simulatingLoadIn}
                className="min-h-[44px] sm:min-h-0 px-3.5 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-black font-mono-tech font-bold text-xs tracking-wide shadow-[0_0_20px_rgba(16,185,129,0.45)] transition cursor-pointer shrink-0"
              >
                {simulatingLoadIn ? 'LOADING IN...' : 'APPROVE PO ($0) & LOAD IN'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const StatCard: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  accent: string;
}> = ({ icon, label, value, sub, accent }) => (
  <div className="bg-black/50 border border-white/10 rounded-xl p-2.5 min-w-0">
    <div className="flex items-center gap-1.5 font-mono-tech text-[9px] text-zinc-400 tracking-wider">
      {icon}
      <span className="truncate">{label}</span>
    </div>
    <div className={`font-display font-bold text-base mt-1 ${accent} truncate`}>{value}</div>
    <div className="font-mono-tech text-[9px] text-zinc-500 mt-0.5 truncate">{sub}</div>
  </div>
);
