import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  X,
  DollarSign,
  Users,
  Truck,
  Zap,
  Weight,
  CheckCircle2,
  ClipboardCheck,
  Clock,
} from 'lucide-react';
import { RigConfig } from '../types/show';
import type { NativeStage } from '../data/showFile';
import { calculateProductionEstimate, formatUSD } from '../data/productionEstimator';
import { EquipmentThumbnail } from './EquipmentThumbnail';

interface CostEstimatorModalProps {
  rig: RigConfig;
  stage?: NativeStage;
  onClose: () => void;
  onDeployRig?: () => void;
}

export const CostEstimatorModal: React.FC<CostEstimatorModalProps> = ({
  rig,
  stage,
  onClose,
  onDeployRig,
}) => {
  const [simulatingLoadIn, setSimulatingLoadIn] = useState(false);
  const [loadInStep, setLoadInStep] = useState(0);
  const [approved, setApproved] = useState(false);

  const dialogRef = useRef<HTMLDialogElement>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const dialog = dialogRef.current!;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    return () => {
      window.clearInterval(timer.current);
      dialog.close();
      opener?.focus();
    };
  }, []);
  const est = useMemo(() => calculateProductionEstimate(rig, stage), [rig, stage]);
  const steps = [
    `Unloading ${est.trucksNeeded} × 53ft semi-truck${est.trucksNeeded > 1 ? 's' : ''} (${Math.round(est.totalWeightLbs).toLocaleString()} lbs)...`,
    `High-steel riggers hoisting trusses & kinetic chain motors...`,
    rig.audioRig.lineArrays ? 'Flying the left and right speaker arrays…' :
      rig.audioRig.subWall ? `Positioning ${rig.audioRig.subCount} subwoofers…` : 'Checking the stage audio patch…',
    `Patching DMX Universes, LED wall processors & LSO laser clearance...`,
    `Crew call complete — SHOW READY FOR FOH!`,
  ];

  const handleSimulateLoadIn = () => {
    dialogRef.current?.querySelector('button')?.focus();
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
    <dialog ref={dialogRef} aria-modal="true" aria-labelledby="production-estimate-title"
      onCancel={event => { event.preventDefault(); onClose(); }}
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}
      onKeyDown={event => {
        if (event.key !== 'Tab') return;
        const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button:enabled');
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (event.shiftKey ? document.activeElement === first : document.activeElement === last) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }}
      className="fixed inset-0 m-0 w-full h-full max-w-none max-h-none border-0 bg-black/70 text-white backdrop-blur-md flex items-center justify-center p-4">
      <div className="production-estimate glass-panel rounded-2xl border border-white/15 w-full max-w-4xl max-h-[86vh] flex flex-col overflow-hidden shadow-[0_0_60px_rgba(0,0,0,0.9)]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 bg-black/65 border-b border-white/10">
          <div>
            <div className="flex items-center gap-2">
              <DollarSign className="w-5 h-5 text-emerald-400" />
              <h2 id="production-estimate-title" className="font-display font-bold text-lg text-white tracking-wide">
                Production estimate
              </h2>
            </div>
            <p className="font-mono-tech text-[11px] text-zinc-400 mt-0.5">
              {rig.name} · Illustrative equipment, crew and transport budget
            </p>
          </div>
          <button
            aria-label="Close production estimate"
            onClick={onClose}
            className="p-1.5 rounded-lg bg-white/5 hover:bg-rose-500/25 text-zinc-300 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

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
        <div className="flex-1 overflow-y-auto p-4 grid grid-cols-1 lg:grid-cols-2 gap-4 text-xs">
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
                <span>STAGEHAND & TECHNICAL CREW LABOR ESTIMATE</span>
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
                    <Truck className="w-3.5 h-3.5 text-sky-400" />
                    53ft Production Semi-Trucks & Drivers ({est.trucksNeeded} trucks)
                  </div>
                  <div className="font-mono-tech text-amber-300 font-semibold">
                    {formatUSD(est.truckingCost)}
                  </div>
                </div>
              </div>
            </div>

            {/* Simulated Virtual Load-In Status */}
            <div className="mt-4 pt-3 border-t border-white/10">
              {simulatingLoadIn && (
                <div className="mb-2.5 p-2.5 rounded-lg bg-cyan-950/60 border border-cyan-400/50 font-mono-tech text-[11px] text-cyan-200 flex items-center gap-2">
                  <Clock className="w-4 h-4 animate-spin shrink-0 text-cyan-400" />
                  <span>{steps[loadInStep]}</span>
                </div>
              )}
              {approved && !simulatingLoadIn && (
                <div className="mb-2.5 p-2.5 rounded-lg bg-emerald-950/60 border border-emerald-400/50 font-mono-tech text-[11px] text-emerald-200 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
                  <span>VIRTUAL WORK ORDER APPROVED ($0.00) — FULL CREW LOAD-IN COMPLETE!</span>
                </div>
              )}

              <div className="rounded-xl bg-gradient-to-r from-emerald-950/80 to-cyan-950/70 border border-emerald-400/40 p-3 flex items-center justify-between gap-3">
                <div>
                  <div className="font-mono-tech text-[10px] text-emerald-300 tracking-wider">
                    YOUR COST IN STAGEFORGE 3D
                  </div>
                  <div className="font-display font-bold text-xl text-white">
                    $0.00 <span className="text-xs font-mono-tech text-emerald-300 font-normal">
                      (SAVED {formatUSD(est.oneNightShowTotal)} TONIGHT!)
                    </span>
                  </div>
                </div>
                <button
                  onClick={handleSimulateLoadIn}
                  disabled={simulatingLoadIn}
                  className="px-3.5 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-black font-mono-tech font-bold text-xs tracking-wide shadow-[0_0_20px_rgba(16,185,129,0.45)] transition cursor-pointer shrink-0"
                >
                  {simulatingLoadIn ? 'LOADING IN...' : 'APPROVE PO ($0) & LOAD IN'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </dialog>
  );
};

const StatCard: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  accent: string;
}> = ({ icon, label, value, sub, accent }) => (
  <div className="bg-black/50 border border-white/10 rounded-xl p-2.5">
    <div className="flex items-center gap-1.5 font-mono-tech text-[9px] text-zinc-400 tracking-wider">
      {icon}
      <span>{label}</span>
    </div>
    <div className={`font-display font-bold text-base mt-1 ${accent}`}>{value}</div>
    <div className="font-mono-tech text-[9px] text-zinc-500 mt-0.5 truncate">{sub}</div>
  </div>
);
