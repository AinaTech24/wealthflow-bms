
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Save, AlertCircle, User, Trash2, Shield, CreditCard, Users, Search, ChevronRight, X, RefreshCcw, AlertTriangle, MapPin, Loader2, ClipboardList, Clock, Key, GitBranch } from 'lucide-react';
import { SharingConfig, TeamMember, BankDetails, Role, Address } from '../types';
import { calculatePayout } from '../services/calculationService';
import { useData, authFetch } from '../contexts/DataContext';
import { useToast } from '../components/Toast';
import { LockMonths } from '../components/LockMonths';

interface SettingsProps {
    currentUser: TeamMember;
}

export const Settings: React.FC<SettingsProps> = ({ currentUser }) => {
    const { globalConfig, updateConfig, team, updateTeam, upsertTeamMember, clearAllData, recalculateAllTransactions } = useData();
    const { showToast, showConfirm } = useToast();

    const [activeTab, setActiveTab] = useState<'profile' | 'config' | 'user-sharing' | 'lead-source' | 'activity' | 'system'>('profile');

    // Activity Log State
    const [activityLog, setActivityLog] = useState<any[]>([]);
    const [activityLoading, setActivityLoading] = useState(false);
    const [activitySearch, setActivitySearch] = useState('');
    const [activityFromDate, setActivityFromDate] = useState('');
    const [activityToDate, setActivityToDate] = useState('');

    // Password Reset Modal State
    const [resetPasswordModal, setResetPasswordModal] = useState<{ userId: string; userName: string } | null>(null);
    const [resetPasswordValue, setResetPasswordValue] = useState('');
    const [resetPasswordConfirm, setResetPasswordConfirm] = useState('');
    const [resetPasswordLoading, setResetPasswordLoading] = useState(false);

    const [profileForm, setProfileForm] = useState<Partial<TeamMember>>({});
    const [bankForm, setBankForm] = useState<BankDetails>({
        accountName: '', accountNumber: '', bankName: '', ifscCode: '', branch: ''
    });
    const [addressForm, setAddressForm] = useState<Address>({
        street: '', city: '', state: '', pincode: '', country: ''
    });

    const [editConfig, setEditConfig] = useState<SharingConfig>(globalConfig);
    const [totalShare, setTotalShare] = useState(0);
    const [testAmount, setTestAmount] = useState<number>(1000);

    // User Sharing Override State
    const [selectedUserForOverride, setSelectedUserForOverride] = useState<TeamMember | null>(null);
    const [userSearch, setUserSearch] = useState('');
    const [userOverrideLevels, setUserOverrideLevels] = useState<Record<number, number>>({});

    useEffect(() => {
        if (currentUser) {
            setProfileForm(currentUser);
            if (currentUser.bankDetails) setBankForm(currentUser.bankDetails);
            if (currentUser.address) setAddressForm(currentUser.address);
        }
        // Only default to config if no tab is selected? No, initial state is 'profile'.
        // If admin, they can switch.
    }, [currentUser]);

    // Fetch activity log when tab is activated
    const fetchActivityLog = useCallback(async () => {
        setActivityLoading(true);
        try {
            const token = localStorage.getItem('wf_token');
            const headers: Record<string, string> = {};
            if (token) headers['Authorization'] = `Bearer ${token}`;
            const res = await fetch('/api/data?type=activity_log', { headers });
            if (res.ok) {
                const data = await res.json();
                // Sort by createdAt descending
                data.sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
                setActivityLog(data);
            }
        } catch (e) {
            console.error('Failed to fetch activity log:', e);
        } finally {
            setActivityLoading(false);
        }
    }, []);

    useEffect(() => {
        if (activeTab === 'activity') {
            fetchActivityLog();
        }
    }, [activeTab, fetchActivityLog]);

    const isValidIFSC = (v: string) => /^[A-Z]{4}0[A-Z0-9]{6}$/.test(v);

    const filteredActivityLog = useMemo(() => {
        return activityLog.filter(entry => {
            if (activitySearch.trim()) {
                const q = activitySearch.toLowerCase();
                const textMatch =
                    (entry.userName || '').toLowerCase().includes(q) ||
                    (entry.action || '').toLowerCase().includes(q) ||
                    (entry.description || '').toLowerCase().includes(q);
                if (!textMatch) return false;
            }
            if (activityFromDate) {
                if (new Date(entry.createdAt) < new Date(activityFromDate)) return false;
            }
            if (activityToDate) {
                const to = new Date(activityToDate);
                to.setHours(23, 59, 59, 999);
                if (new Date(entry.createdAt) > to) return false;
            }
            return true;
        });
    }, [activityLog, activitySearch, activityFromDate, activityToDate]);

    const formatRelativeTime = (dateStr: string) => {
        const date = new Date(dateStr);
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffMins = Math.floor(diffMs / 60000);
        if (diffMins < 1) return 'Just now';
        if (diffMins < 60) return `${diffMins}m ago`;
        const diffHrs = Math.floor(diffMins / 60);
        if (diffHrs < 24) return `${diffHrs}h ago`;
        const diffDays = Math.floor(diffHrs / 24);
        if (diffDays < 7) return `${diffDays}d ago`;
        return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    };

    useEffect(() => {
        setEditConfig(globalConfig);
    }, [globalConfig]);

    useEffect(() => {
        // Include 0 in the sum
        // Fix: Explicitly cast Object.values to number[] to resolve 'unknown' arithmetic error on line 51
        const sum = ([1, 2, 3, 4, 5, 6, 7] as number[]).reduce((a: number, l: number) => a + (Number((editConfig.levels as any)[l]) || 0), 0);
        setTotalShare(Math.round(sum * 100) / 100);
    }, [editConfig]);

    const handleProfileSave = async () => {
        if (!currentUser) return;

        const updatedMember: TeamMember = {
            ...currentUser,
            bankDetails: bankForm,
            address: addressForm,
            arnNumber: profileForm.arnNumber,
            arnValidTill: profileForm.arnValidTill,
            euinNumber: profileForm.euinNumber,
            euinValidTill: profileForm.euinValidTill,
            gstNumber: profileForm.gstNumber,
            pan: (profileForm as any).pan,
            signature: (profileForm as any).signature,
        };

        // Single-record save (never POST the whole team from a possibly-stale tab).
        // The server allows an RM to update their OWN record with role/level/rate
        // unchanged, so RMs can maintain bank details, GSTIN, PAN and signature.
        const ok = await upsertTeamMember(updatedMember);
        if (ok) showToast('Profile information updated successfully!', 'success');
    };

    const handleConfigSave = async () => {
        // The 100%-levels grid only governs the SLICES/global model. RESIDUAL uses
        // per-RM rates + company cut + residual level, so it doesn't require it.
        if ((editConfig as any).leadSharingModel !== 'RESIDUAL' && totalShare !== 100) return;
        updateConfig(editConfig);
        const shouldRecalc = await showConfirm({
            title: 'Recalculate Transactions?',
            message: 'Do you want to recalculate all historical transactions with these new global settings?',
            confirmText: 'Recalculate',
            variant: 'info'
        });
        if (shouldRecalc) {
            recalculateAllTransactions();
        }
        showToast('Global Configuration updated successfully!', 'success');
    };

    const handleLevelChange = (level: number, val: string) => {
        const num = parseFloat(val) || 0;
        setEditConfig(prev => ({ ...prev, levels: { ...prev.levels, [level]: num } }));
    };

    const handleNameChange = (level: number, val: string) => {
        setEditConfig(prev => ({ ...prev, levelNames: { ...prev.levelNames, [level]: val } }));
    };

    // ── Lead-Source Sharing Matrix handlers ──────────────────────────────
    // matrix[sourceLevel][payeeLevel] = % of gross. Company = residue per row.
    const handleMatrixChange = (sourceLevel: number, payeeLevel: number, val: string) => {
        const num = Math.max(0, parseFloat(val) || 0);
        setEditConfig(prev => {
            const matrix = { ...(prev.leadSourceMatrix || {}) };
            const row = { ...(matrix[sourceLevel] || {}) };
            row[payeeLevel] = num;
            matrix[sourceLevel] = row;
            return { ...prev, leadSourceMatrix: matrix };
        });
    };
    const rowTotal = (sourceLevel: number): number => {
        const row = editConfig.leadSourceMatrix?.[sourceLevel] || {};
        return [1, 2, 3, 4, 5, 6, 7].reduce((s, l) => s + (Number((row as any)[l]) || 0), 0);
    };
    const anyRowOver100 = [1, 2, 3, 4, 5, 6, 7].some(l => rowTotal(l) > 100);
    // ── Cumulative designation model handlers ────────────────────────────
    const handleCumulativeChange = (level: number, val: string) => {
        const num = Math.max(0, parseFloat(val) || 0);
        setEditConfig(prev => ({ ...prev, designationCumulative: { ...(prev.designationCumulative || {}), [level]: num } }));
    };
    const handleLeadPctChange = (val: string) => {
        const num = Math.max(0, parseFloat(val) || 0);
        setEditConfig(prev => ({ ...prev, leadSourcePct: num }));
    };
    const handleModelChange = (model: 'SLICES' | 'CUMULATIVE' | 'RESIDUAL') => {
        setEditConfig(prev => ({ ...prev, leadSharingModel: model } as any));
    };
    const cumulativeMonotonicOk = (() => {
        const c = editConfig.designationCumulative || {};
        let prev = 0;
        for (let l = 1; l <= 7; l++) { const v = Number((c as any)[l]) || 0; if (v && v < prev) return false; if (v) prev = v; }
        return prev <= 100;
    })();

    const handleLeadSourceSave = async () => {
        if (anyRowOver100) { showToast('A lead-source row exceeds 100%. Fix it before saving.', 'error'); return; }
        if (editConfig.leadSharingModel === 'CUMULATIVE' && !cumulativeMonotonicOk) {
            showToast('Cumulative rates must increase by level and stay ≤ 100%.', 'error'); return;
        }
        updateConfig(editConfig);
        const shouldRecalc = await showConfirm({
            title: 'Recalculate Transactions?',
            message: 'Apply the lead-source matrix to all historical transactions now? (Clients with no lead source are unaffected.)',
            confirmText: 'Recalculate',
            variant: 'info'
        });
        if (shouldRecalc) recalculateAllTransactions();
        showToast('Lead-source sharing matrix saved.', 'success');
    };

    const filteredTeam = useMemo(() => {
        return team.filter(m =>
            m.name.toLowerCase().includes(userSearch.toLowerCase()) ||
            m.code.toLowerCase().includes(userSearch.toLowerCase())
        ).sort((a, b) => a.level - b.level);
    }, [team, userSearch]);

    const handleSelectUserForOverride = (member: TeamMember) => {
        setSelectedUserForOverride(member);
        const initialLevels: Record<number, number> = {};
        // Levels are 1..7 throughout the app — keep keys aligned with what the
        // form renders so the total sum only counts visible inputs.
        [1, 2, 3, 4, 5, 6, 7].forEach(l => {
            initialLevels[l] = member.customLevels?.[l as keyof typeof member.customLevels] ?? globalConfig.levels[l as keyof typeof globalConfig.levels] ?? 0;
        });
        setUserOverrideLevels(initialLevels);
    };

    const handleUserLevelChange = (level: number, val: string) => {
        const num = parseFloat(val) || 0;
        setUserOverrideLevels(prev => ({ ...prev, [level]: num }));
    };

    const handleSaveUserOverride = async () => {
        if (!selectedUserForOverride) return;
        // Slices are now % of GROSS — sum can be anywhere in [0, 100]; the
        // remainder is automatically company retention.
        const VISIBLE_LEVELS = [1, 2, 3, 4, 5, 6, 7] as const;
        const sum = VISIBLE_LEVELS.reduce((acc, lvl) => acc + (userOverrideLevels[lvl] || 0), 0);
        if (sum < 0 || sum > 100.001) {
            showToast(`Total of all levels cannot exceed 100%. Current total: ${sum}%`, 'warning');
            return;
        }

        // Persist ONLY this member. This used to call updateTeam(<whole array>),
        // which pushes this tab's copy of all 184 members back to the server and
        // silently reverts anything changed elsewhere since the page loaded — the
        // same mass-revert already fixed on the Clients/Team screens. And the
        // success toast fired unconditionally, so a rejected save still said
        // "saved successfully".
        const current = team.find(m => m.id === selectedUserForOverride.id);
        if (!current) { showToast('That team member no longer exists. Reload and try again.', 'error'); return; }
        const saved = await upsertTeamMember({ ...current, customLevels: userOverrideLevels });
        if (!saved) return;                       // saveToDb already explained why
        showToast(`Sharing overrides for ${selectedUserForOverride.name} saved.`, 'success');

        const shouldRecalc = await showConfirm({
            title: 'Recalculate Payouts?',
            message: `Recalculate historical payouts for ${selectedUserForOverride.name} using this new sharing rule? Settled (locked) months are never changed.`,
            confirmText: 'Recalculate',
            variant: 'info'
        });
        if (shouldRecalc) {
            recalculateAllTransactions();
        }
        setSelectedUserForOverride(null);
    };

    const handleResetUserOverride = async () => {
        if (!selectedUserForOverride) return;
        // Persist ONLY this member — see handleSaveUserOverride: pushing the whole
        // team array reverts everyone else's rates to this tab's stale copy.
        const current = team.find(m => m.id === selectedUserForOverride.id);
        if (!current) { showToast('That team member no longer exists. Reload and try again.', 'error'); return; }
        const { customLevels, ...rest } = current;
        const ok = await upsertTeamMember({ ...rest, customLevels: {} } as TeamMember);
        if (!ok) return;
        showToast(`Sharing overrides for ${selectedUserForOverride.name} reset to global defaults.`, 'info');
        setSelectedUserForOverride(null);
    };

    const [isRecalculating, setIsRecalculating] = useState(false);
    // Folio ownership clean-up — see the panel in the System tab.
    const [folioBusy, setFolioBusy] = useState(false);
    const [folioResult, setFolioResult] = useState<any>(null);
    // Assign folios to one RM, optionally moving that month's existing rows with them.
    const [faFolios, setFaFolios] = useState('');
    const [faRm, setFaRm] = useState('');
    const [faMonth, setFaMonth] = useState('');
    const [faBusy, setFaBusy] = useState(false);
    const [faResult, setFaResult] = useState<any>(null);
    // Branch restructure: move everyone under one manager beneath another.
    const [brFrom, setBrFrom] = useState('');
    const [brTo, setBrTo] = useState('');
    const [brBusy, setBrBusy] = useState(false);
    const [brResult, setBrResult] = useState<any>(null);

    const handlePasswordReset = async () => {
        if (!resetPasswordModal) return;
        if (resetPasswordValue.length < 6) {
            showToast('Password must be at least 6 characters.', 'warning');
            return;
        }
        if (resetPasswordValue !== resetPasswordConfirm) {
            showToast('Passwords do not match.', 'warning');
            return;
        }
        setResetPasswordLoading(true);
        try {
            const token = localStorage.getItem('wf_token');
            const res = await fetch('/api/auth/reset-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ userId: resetPasswordModal.userId, newPassword: resetPasswordValue }),
            });
            if (!res.ok) throw new Error((await res.json()).error || 'Failed');
            showToast(`Password reset for ${resetPasswordModal.userName}.`, 'success');
            setResetPasswordModal(null);
            setResetPasswordValue('');
            setResetPasswordConfirm('');
        } catch (e: any) {
            showToast(e.message || 'Failed to reset password.', 'error');
        } finally {
            setResetPasswordLoading(false);
        }
    };

    const runAssignForm = async () => {
        const folios = faFolios.split(/[\s,;]+/).map(f => f.trim()).filter(Boolean);
        if (!folios.length || !faRm) { showToast('Enter at least one folio and choose the RM.', 'error'); return; }
        const rmName = team.find(t => t.id === faRm)?.name?.trim();
        const confirmed = await showConfirm({
            title: 'Assign these folios to one RM?',
            message: `${folios.length} folio(s) will stay only on ${rmName}'s record and be removed from every other record that claims them.${faMonth ? ` Their existing ${faMonth} rows will also be pointed at ${rmName}'s record.` : ' No existing rows are moved.'} Payout earnings follow only after Recalculate.`,
            confirmText: 'Assign',
            variant: 'warning',
        });
        if (!confirmed) return;
        setFaBusy(true); setFaResult(null);
        try {
            const r = await authFetch('/api/data', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'folio_assign', payload: { assign: folios.map(f => ({ folio: f, rmId: faRm })), repointPeriod: faMonth } }),
            });
            const j = await r.json();
            if (!r.ok) { showToast(j?.error || 'Could not assign the folios.', 'error'); return; }
            setFaResult(j);
            showToast(`${j.assigned} folio(s) assigned${faMonth ? `, ${j.rowsMoved} row(s) moved` : ''}${j.skipped?.length ? `, ${j.skipped.length} skipped` : ''}.`, j.skipped?.length ? 'warning' : 'success');
        } catch (e: any) {
            showToast(`Assign did not finish (${e?.message || 'no response'}). Nothing may have changed; run Check only to see.`, 'error');
        } finally { setFaBusy(false); }
    };

    const runBranch = async (apply: boolean) => {
        if (!brFrom || !brTo) { showToast('Choose both managers first.', 'error'); return; }
        if (apply) {
            const fromName = team.find(t => t.id === brFrom)?.name, toName = team.find(t => t.id === brTo)?.name;
            const confirmed = await showConfirm({
                title: 'Move this branch?',
                message: `Everyone who reports to ${fromName} will report to ${toName}, and ${brResult?.clients ?? 'the'} client(s) with no manager at that level get ${toName} placed there. No slot that is already filled is changed. Transactions, payouts, invoices and payments are not touched, and nothing is recalculated. This applies to EVERY month, not just August.`,
                confirmText: 'Move branch',
                variant: 'warning',
            });
            if (!confirmed) return;
        }
        setBrBusy(true);
        try {
            const r = await authFetch('/api/data', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'branch_restructure', payload: { fromId: brFrom, toId: brTo, apply } }),
            });
            const j = await r.json();
            if (!r.ok) { showToast(j?.error || 'That did not work.', 'error'); return; }
            setBrResult(j);
            if (apply) {
                showToast(`Done: ${j.applied.clients} client(s) and ${j.applied.team} team member(s) moved. Reloading...`, 'success');
                setTimeout(() => window.location.reload(), 1800);
            }
        } catch (e: any) {
            showToast(`That did not finish (${e?.message || 'no response'}). Run Check first to see where it stands.`, 'error');
        } finally { setBrBusy(false); }
    };

    // Settle one folio whose investor is filed under several RMs. The statements cannot
    // say which RM owns it — that is the firm's call — so this applies the call and
    // removes the folio from every other record. No transaction is touched.
    const assignFolio = async (folio: string, rmId: string, rmName: string) => {
        const confirmed = await showConfirm({
            title: 'Give this folio to one RM?',
            message: `Folio ${folio} will stay only on ${rmName}'s record, and every other record loses its claim to it. Transactions are not touched. Run Recalculate afterwards.`,
            confirmText: 'Assign',
            variant: 'warning',
        });
        if (!confirmed) return;
        setFolioBusy(true);
        try {
            const r = await authFetch('/api/data', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'folio_assign', payload: { assign: [{ folio, rmId }] } }),
            });
            const j = await r.json();
            if (!r.ok) { showToast(j?.error || 'Could not assign the folio.', 'error'); return; }
            if (j.skipped?.length) { showToast(j.skipped[0].why, 'error'); return; }
            showToast(`Folio ${folio} now belongs to ${rmName} only.`, 'success');
            const c = await authFetch('/api/data', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'folio_conflicts', payload: { apply: false } }),
            });
            if (c.ok) setFolioResult(await c.json());
        } catch (e: any) {
            showToast(`Assign did not finish (${e?.message || 'no response'}). Run Check only to see where it stands.`, 'error');
        } finally { setFolioBusy(false); }
    };

    const handleManualRecalculate = async () => {
        const confirmed = await showConfirm({
            title: 'Recalculate All Transactions?',
            message: 'Are you sure you want to recalculate ALL historical transactions? This might take a moment if you have thousands of records.',
            confirmText: 'Recalculate All',
            variant: 'warning'
        });
        if (!confirmed) return;
        setIsRecalculating(true);
        try {
            await recalculateAllTransactions();
            showToast("Recalculation successful! All earnings have been updated.", 'success');
        } catch (err) {
            console.error(err);
            showToast("Recalculation failed. Please check the console for errors.", 'error');
        } finally {
            setIsRecalculating(false);
        }
    };

    const dummyHierarchy = { level1Id: 'x', level2Id: 'x', level3Id: 'x', level4Id: 'x', level5Id: 'x', level6Id: 'x', level7Id: 'x' };
    const calculationPreview = calculatePayout(testAmount, editConfig, dummyHierarchy);

    return (
        <>
        <div className="space-y-6 text-slate-900 dark:text-slate-100">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">Settings</h1>
                    <p className="text-slate-500 mt-1">System behavior and profile management.</p>
                </div>
                <div className="flex flex-wrap gap-2 bg-white dark:bg-slate-800 p-1 rounded-lg border border-slate-200 dark:border-slate-700 shadow-sm">
                    <button onClick={() => setActiveTab('profile')} className={`flex items-center px-4 py-2 text-sm font-medium rounded-md transition ${activeTab === 'profile' ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-400' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'}`}><User className="w-4 h-4 mr-2" />Profile</button>
                    {currentUser?.role === Role.ADMIN && (
                        <>
                            <button onClick={() => setActiveTab('config')} className={`flex items-center px-4 py-2 text-sm font-medium rounded-md transition ${activeTab === 'config' ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-400' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'}`}><Shield className="w-4 h-4 mr-2" />Global Rules</button>
                            <button onClick={() => setActiveTab('user-sharing')} className={`flex items-center px-4 py-2 text-sm font-medium rounded-md transition ${activeTab === 'user-sharing' ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-400' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'}`}><Users className="w-4 h-4 mr-2" />User Sharing</button>
                            <button onClick={() => setActiveTab('lead-source')} className={`flex items-center px-4 py-2 text-sm font-medium rounded-md transition ${activeTab === 'lead-source' ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-400' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'}`}><GitBranch className="w-4 h-4 mr-2" />Lead Source</button>
                            <button onClick={() => setActiveTab('activity')} className={`flex items-center px-4 py-2 text-sm font-medium rounded-md transition ${activeTab === 'activity' ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-400' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'}`}><ClipboardList className="w-4 h-4 mr-2" />Activity Log</button>
                            <button onClick={() => setActiveTab('system')} className={`flex items-center px-4 py-2 text-sm font-medium rounded-md transition ${activeTab === 'system' ? 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'}`}><AlertTriangle className="w-4 h-4 mr-2" />System</button>
                        </>
                    )}
                </div>
            </div>

            {activeTab === 'profile' && (
                <div className="space-y-6 text-slate-900 dark:text-slate-100">
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        <div className="bg-white dark:bg-slate-800 p-6 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm space-y-6">
                            <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100 flex items-center"><User className="w-5 h-5 mr-2 text-slate-500" />Personal Information</h3>
                            <div className="space-y-4">
                                <div>
                                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Display Name</label>
                                    <input type="text" value={profileForm.name || ''} readOnly className="w-full bg-slate-50 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 p-3 rounded-xl mt-1 font-bold text-slate-600 dark:text-slate-300 cursor-not-allowed" />
                                </div>
                                <div>
                                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Account Context</label>
                                    <input type="text" value={`${profileForm.role} - Level ${profileForm.level} (${globalConfig.levelNames[profileForm.level as keyof typeof globalConfig.levelNames]})`} readOnly className="w-full bg-slate-50 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 p-3 rounded-xl mt-1 font-bold text-slate-600 dark:text-slate-300 cursor-not-allowed" />
                                </div>
                            </div>
                        </div>

                        <div className="bg-white dark:bg-slate-800 p-6 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm space-y-6">
                            <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100 flex items-center"><CreditCard className="w-5 h-5 mr-2 text-slate-500" />Bank Details</h3>
                            <div className="space-y-4">
                                <div>
                                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Account Name</label>
                                    <input type="text" value={bankForm.accountName} onChange={(e) => setBankForm({ ...bankForm, accountName: e.target.value })} className="w-full border border-slate-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 p-3 rounded-xl mt-1 font-medium text-sm focus:ring-2 focus:ring-blue-500 transition" placeholder="Name as per Bank" />
                                </div>
                                <div className="grid grid-cols-2 gap-4">
                                    <div>
                                        <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Account Number</label>
                                        <input type="text" value={bankForm.accountNumber} onChange={(e) => setBankForm({ ...bankForm, accountNumber: e.target.value })} className="w-full border border-slate-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 p-3 rounded-xl mt-1 font-medium text-sm focus:ring-2 focus:ring-blue-500 transition" placeholder="XXXXXX1234" />
                                    </div>
                                    <div>
                                        <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">IFSC Code</label>
                                        <input
                                            type="text"
                                            value={bankForm.ifscCode}
                                            onChange={(e) => setBankForm({ ...bankForm, ifscCode: e.target.value.toUpperCase() })}
                                            onBlur={(e) => { if (e.target.value && !isValidIFSC(e.target.value)) showToast('Invalid IFSC format (e.g. HDFC0001234)', 'warning'); }}
                                            className={`w-full border p-3 rounded-xl mt-1 font-medium text-sm focus:ring-2 focus:ring-blue-500 transition uppercase ${bankForm.ifscCode && !isValidIFSC(bankForm.ifscCode) ? 'border-red-400' : 'border-slate-200'}`}
                                            placeholder="HDFC0001234"
                                        />
                                        {bankForm.ifscCode && !isValidIFSC(bankForm.ifscCode) && (
                                            <p className="text-red-500 text-xs mt-1">Invalid IFSC format</p>
                                        )}
                                    </div>
                                </div>
                                <div className="grid grid-cols-2 gap-4">
                                    <div>
                                        <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Bank Name</label>
                                        <input type="text" value={bankForm.bankName} onChange={(e) => setBankForm({ ...bankForm, bankName: e.target.value })} className="w-full border border-slate-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 p-3 rounded-xl mt-1 font-medium text-sm focus:ring-2 focus:ring-blue-500 transition" placeholder="HDFC Bank" />
                                    </div>
                                    <div>
                                        <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Branch</label>
                                        <input type="text" value={bankForm.branch || ''} onChange={(e) => setBankForm({ ...bankForm, branch: e.target.value })} className="w-full border border-slate-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 p-3 rounded-xl mt-1 font-medium text-sm focus:ring-2 focus:ring-blue-500 transition" placeholder="Mumbai Main" />
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="bg-white dark:bg-slate-800 p-6 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm space-y-6 lg:col-span-2">
                            <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100 flex items-center"><MapPin className="w-5 h-5 mr-2 text-slate-500" />Address & Contact</h3>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="md:col-span-2">
                                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Street Address</label>
                                    <input type="text" value={addressForm.street} onChange={(e) => setAddressForm({ ...addressForm, street: e.target.value })} className="w-full border border-slate-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 p-3 rounded-xl mt-1 font-medium text-sm focus:ring-2 focus:ring-blue-500 transition" placeholder="123, Wealth Street, Business Park" />
                                </div>
                                <div>
                                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">City</label>
                                    <input type="text" value={addressForm.city} onChange={(e) => setAddressForm({ ...addressForm, city: e.target.value })} className="w-full border border-slate-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 p-3 rounded-xl mt-1 font-medium text-sm focus:ring-2 focus:ring-blue-500 transition" placeholder="Mumbai" />
                                </div>
                                <div>
                                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">State / Province</label>
                                    <input type="text" value={addressForm.state} onChange={(e) => setAddressForm({ ...addressForm, state: e.target.value })} className="w-full border border-slate-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 p-3 rounded-xl mt-1 font-medium text-sm focus:ring-2 focus:ring-blue-500 transition" placeholder="Maharashtra" />
                                </div>
                                <div>
                                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Pincode / Zip</label>
                                    <input type="text" value={addressForm.pincode} onChange={(e) => setAddressForm({ ...addressForm, pincode: e.target.value })} className="w-full border border-slate-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 p-3 rounded-xl mt-1 font-medium text-sm focus:ring-2 focus:ring-blue-500 transition" placeholder="400001" />
                                </div>
                                <div>
                                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Country</label>
                                    <input type="text" value={addressForm.country} onChange={(e) => setAddressForm({ ...addressForm, country: e.target.value })} className="w-full border border-slate-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 p-3 rounded-xl mt-1 font-medium text-sm focus:ring-2 focus:ring-blue-500 transition" placeholder="India" />
                                </div>
                            </div>
                        </div>

                        {/* SEBI/AMFI compliance */}
                        <div className="bg-white dark:bg-slate-800 p-6 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm">
                            <h3 className="text-base font-bold text-slate-900 dark:text-slate-100 mb-1">SEBI/AMFI Registration</h3>
                            <p className="text-xs text-slate-500 dark:text-slate-400 mb-5">ARN expires every 3 years; EUIN every 5. Dashboard alerts fire 30 days before expiry.</p>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">ARN Number</label>
                                    <input
                                        type="text"
                                        value={profileForm.arnNumber || ''}
                                        onChange={(e) => setProfileForm({ ...profileForm, arnNumber: e.target.value.toUpperCase() })}
                                        placeholder="ARN-12345"
                                        className="w-full border border-slate-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 p-3 rounded-xl mt-1 font-medium text-sm focus:ring-2 focus:ring-blue-500 transition uppercase"
                                    />
                                </div>
                                <div>
                                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">ARN Valid Till</label>
                                    <input
                                        type="date"
                                        value={profileForm.arnValidTill || ''}
                                        onChange={(e) => setProfileForm({ ...profileForm, arnValidTill: e.target.value })}
                                        className="w-full border border-slate-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 p-3 rounded-xl mt-1 font-medium text-sm focus:ring-2 focus:ring-blue-500 transition"
                                    />
                                </div>
                                <div>
                                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">EUIN Number</label>
                                    <input
                                        type="text"
                                        value={profileForm.euinNumber || ''}
                                        onChange={(e) => setProfileForm({ ...profileForm, euinNumber: e.target.value.toUpperCase() })}
                                        placeholder="E123456"
                                        className="w-full border border-slate-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 p-3 rounded-xl mt-1 font-medium text-sm focus:ring-2 focus:ring-blue-500 transition uppercase"
                                    />
                                </div>
                                <div>
                                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">EUIN Valid Till</label>
                                    <input
                                        type="date"
                                        value={profileForm.euinValidTill || ''}
                                        onChange={(e) => setProfileForm({ ...profileForm, euinValidTill: e.target.value })}
                                        className="w-full border border-slate-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 p-3 rounded-xl mt-1 font-medium text-sm focus:ring-2 focus:ring-blue-500 transition"
                                    />
                                </div>
                            </div>
                        </div>

                        {/* Tax identity + signature — printed on the RM's tax invoices */}
                        <div className="bg-white dark:bg-slate-800 p-6 rounded-2xl border border-slate-200 dark:border-slate-700">
                            <h3 className="text-sm font-black text-slate-700 dark:text-slate-200 uppercase tracking-widest mb-4">Invoice Details</h3>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">GSTIN <span className="normal-case font-medium">(GST added to invoice only if set)</span></label>
                                    <input type="text" value={profileForm.gstNumber || ''} onChange={(e) => setProfileForm({ ...profileForm, gstNumber: e.target.value.toUpperCase() })} placeholder="27ABCDE1234F1Z5" className="w-full border border-slate-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 p-3 rounded-xl mt-1 font-medium text-sm focus:ring-2 focus:ring-blue-500 transition uppercase" />
                                </div>
                                <div>
                                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">PAN</label>
                                    <input type="text" value={(profileForm as any).pan || ''} onChange={(e) => setProfileForm({ ...profileForm, pan: e.target.value.toUpperCase() } as any)} placeholder="ABCDE1234F" maxLength={10} className="w-full border border-slate-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 p-3 rounded-xl mt-1 font-medium text-sm focus:ring-2 focus:ring-blue-500 transition uppercase" />
                                </div>
                                <div className="md:col-span-2">
                                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Signature <span className="normal-case font-medium">(auto-added above "Authorised Signatory")</span></label>
                                    <div className="flex items-center gap-4 mt-1">
                                        <input type="file" accept="image/png,image/jpeg" onChange={(e) => {
                                            const file = e.target.files?.[0]; if (!file) return;
                                            if (file.size > 400 * 1024) { showToast('Signature image must be under 400 KB.', 'warning'); return; }
                                            const reader = new FileReader();
                                            reader.onload = () => setProfileForm({ ...profileForm, signature: String(reader.result) } as any);
                                            reader.readAsDataURL(file);
                                        }} className="text-xs" />
                                        {(profileForm as any).signature && (
                                            <div className="flex items-center gap-2">
                                                <img src={(profileForm as any).signature} alt="signature" className="h-12 border border-slate-200 dark:border-slate-600 rounded bg-white p-1" />
                                                <button type="button" onClick={() => setProfileForm({ ...profileForm, signature: undefined } as any)} className="text-[10px] font-bold text-red-500 hover:underline">Remove</button>
                                            </div>
                                        )}
                                    </div>
                                    <p className="text-[10px] text-slate-400 mt-1">PNG or JPEG, transparent background recommended, under 400 KB.</p>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="flex justify-end pt-2">
                        <button onClick={handleProfileSave} className="bg-blue-600 text-white px-8 py-3 rounded-xl font-bold hover:bg-blue-700 transition shadow-lg shadow-blue-100 flex items-center">
                            <Save className="w-4 h-4 mr-2" /> Save Profile Changes
                        </button>
                    </div>
                </div>
            )}

            {activeTab === 'config' && currentUser?.role === Role.ADMIN && (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    <div className="lg:col-span-2 space-y-6">
                        <div className="flex items-center justify-between">
                            <h2 className="text-lg font-bold text-slate-900">Global Payout Rules</h2>
                            {(() => { const canSave = (editConfig as any).leadSharingModel === 'RESIDUAL' || totalShare === 100; return (
                            <button disabled={!canSave} onClick={handleConfigSave} className={`flex items-center px-4 py-2 rounded-lg text-sm font-medium transition ${canSave ? 'bg-blue-600 text-white shadow-lg shadow-blue-100' : 'bg-slate-200 text-slate-400'}`}><Save className="w-4 h-4 mr-2" /> Save Global Defaults</button>
                            ); })()}
                        </div>

                        <div className="bg-white dark:bg-slate-800 p-6 rounded-xl border border-slate-200 shadow-sm">
                            <div className="flex items-start justify-between">
                                <div>
                                    <h3 className="text-lg font-bold text-slate-900">Company Retention (%)</h3>
                                    <p className="text-xs text-slate-500">Fixed expense deducted from gross before payout pool.</p>
                                </div>
                                <input type="number" value={editConfig.companyExpensePct} onChange={(e) => setEditConfig({ ...editConfig, companyExpensePct: parseFloat(e.target.value) || 0 })} className="w-20 p-2 border rounded-lg text-right font-bold text-blue-600 focus:ring-2 focus:ring-blue-500 outline-none" />
                            </div>
                        </div>

                        {/* Firm identity (used for GST intra/inter-state split on invoices) */}
                        <div className="bg-white dark:bg-slate-800 p-6 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm">
                            <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">Firm GST Registration</h3>
                            <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">Used on invoices and to compute the GST split. If the payee is in the same state, the GST splits into CGST+SGST; otherwise it's IGST.</p>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Firm Name</label>
                                    <input type="text" value={editConfig.firmName || ''} onChange={(e) => setEditConfig({ ...editConfig, firmName: e.target.value })} className="w-full border border-slate-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 p-3 rounded-xl mt-1 font-medium text-sm focus:ring-2 focus:ring-blue-500 transition" placeholder="My Wealth Pvt Ltd" />
                                </div>
                                <div>
                                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Registered State</label>
                                    <input type="text" value={editConfig.firmState || ''} onChange={(e) => setEditConfig({ ...editConfig, firmState: e.target.value })} className="w-full border border-slate-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 p-3 rounded-xl mt-1 font-medium text-sm focus:ring-2 focus:ring-blue-500 transition" placeholder="Maharashtra" />
                                </div>
                                <div>
                                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Firm GSTIN</label>
                                    <input type="text" value={editConfig.firmGstin || ''} onChange={(e) => setEditConfig({ ...editConfig, firmGstin: e.target.value.toUpperCase() })} className="w-full border border-slate-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 p-3 rounded-xl mt-1 font-medium text-sm focus:ring-2 focus:ring-blue-500 transition uppercase" placeholder="27ABCDE1234F1Z5" />
                                </div>
                                <div>
                                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Firm PAN</label>
                                    <input type="text" value={editConfig.firmPan || ''} onChange={(e) => setEditConfig({ ...editConfig, firmPan: e.target.value.toUpperCase() })} className="w-full border border-slate-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 p-3 rounded-xl mt-1 font-medium text-sm focus:ring-2 focus:ring-blue-500 transition uppercase" placeholder="ABCDE1234F" />
                                </div>
                                <div>
                                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">GST State Code</label>
                                    <input type="text" value={(editConfig as any).firmStateCode || ''} onChange={(e) => setEditConfig({ ...editConfig, firmStateCode: e.target.value } as any)} className="w-full border border-slate-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 p-3 rounded-xl mt-1 font-medium text-sm focus:ring-2 focus:ring-blue-500 transition" placeholder="27" />
                                </div>
                                <div className="md:col-span-2">
                                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Company Address — Line 1</label>
                                    <input type="text" value={(editConfig as any).firmAddressLine1 || ''} onChange={(e) => setEditConfig({ ...editConfig, firmAddressLine1: e.target.value } as any)} className="w-full border border-slate-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 p-3 rounded-xl mt-1 font-medium text-sm focus:ring-2 focus:ring-blue-500 transition" placeholder="Flat No B-404, Valencia Building, Bhakti Park" />
                                </div>
                                <div className="md:col-span-2">
                                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Company Address — Line 2</label>
                                    <input type="text" value={(editConfig as any).firmAddressLine2 || ''} onChange={(e) => setEditConfig({ ...editConfig, firmAddressLine2: e.target.value } as any)} className="w-full border border-slate-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 p-3 rounded-xl mt-1 font-medium text-sm focus:ring-2 focus:ring-blue-500 transition" placeholder="Wadala East, Antop Hill, Mumbai - 400037" />
                                </div>
                                <div>
                                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Default HSN/SAC</label>
                                    <input type="text" value={(editConfig as any).defaultHsnSac || ''} onChange={(e) => setEditConfig({ ...editConfig, defaultHsnSac: e.target.value } as any)} className="w-full border border-slate-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 p-3 rounded-xl mt-1 font-medium text-sm focus:ring-2 focus:ring-blue-500 transition" placeholder="997152" />
                                </div>
                                <div>
                                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Default TDS %</label>
                                    <input type="number" step="0.5" value={(editConfig as any).defaultTdsRate ?? ''} onChange={(e) => setEditConfig({ ...editConfig, defaultTdsRate: e.target.value === '' ? undefined : Number(e.target.value) } as any)} className="w-full border border-slate-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 p-3 rounded-xl mt-1 font-medium text-sm focus:ring-2 focus:ring-blue-500 transition" placeholder="2" />
                                </div>
                                <div>
                                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Default GST %</label>
                                    <input type="number" step="1" value={(editConfig as any).defaultGstRate ?? ''} onChange={(e) => setEditConfig({ ...editConfig, defaultGstRate: e.target.value === '' ? undefined : Number(e.target.value) } as any)} className="w-full border border-slate-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 p-3 rounded-xl mt-1 font-medium text-sm focus:ring-2 focus:ring-blue-500 transition" placeholder="18" />
                                </div>
                            </div>
                            <p className="text-[10px] text-slate-400 mt-3">These appear as the "To" (company) block, HSN/SAC and default taxes on every RM tax invoice. GST is applied only to RMs who have a GSTIN on their profile.</p>
                        </div>

                        <div className="bg-white dark:bg-slate-800 p-6 rounded-xl border border-slate-200 shadow-sm">
                            <div className="flex items-center justify-between mb-6">
                                <h3 className="text-lg font-bold text-slate-900">Standard Multi-Layer Split</h3>
                                <div className={`px-3 py-1 rounded-full text-sm font-bold ${totalShare === 100 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>Total Allocation: {totalShare}%</div>
                            </div>
                            <div className="space-y-3">
                                {[7, 6, 5, 4, 3, 2, 1].map((lvl) => (
                                    <div key={lvl} className="flex items-center p-3 bg-slate-50 rounded-lg border border-slate-100">
                                        <div className="w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm mr-4 bg-blue-100 text-blue-700 shadow-sm">L{lvl}</div>
                                        <input type="text" value={editConfig.levelNames?.[lvl as keyof typeof editConfig.levelNames] || ''} onChange={(e) => handleNameChange(lvl, e.target.value)} className="flex-1 bg-transparent border-b border-dashed border-slate-300 mr-4 outline-none text-sm font-medium" />
                                        <div className="flex items-center bg-white border rounded-lg overflow-hidden shadow-sm">
                                            <input type="number" value={editConfig.levels[lvl as keyof typeof editConfig.levels]} onChange={(e) => handleLevelChange(lvl, e.target.value)} className="w-20 p-2 text-right text-sm font-bold" />
                                            <span className="px-2 text-slate-400 bg-slate-50 border-l">%</span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>

                    <div className="lg:col-span-1">
                        <div className="bg-slate-900 text-white p-6 rounded-xl shadow-xl sticky top-6">
                            <h3 className="text-lg font-bold mb-4 flex items-center text-blue-400"><RefreshCcw className="w-4 h-4 mr-2" /> Real-time Simulator</h3>
                            <div className="mb-6">
                                <label className="text-[10px] font-bold text-slate-500 uppercase block mb-1">Testing Gross Amount</label>
                                <input type="number" value={testAmount} onChange={(e) => setTestAmount(parseFloat(e.target.value))} className="w-full bg-slate-800 border border-slate-700 rounded-xl p-3 text-white font-mono text-xl" />
                            </div>
                            <div className="space-y-3 pt-4 border-t border-slate-700">
                                <div className="flex justify-between items-center"><span className="text-slate-400 text-sm">Retention ({editConfig.companyExpensePct}%)</span><span className="text-red-400 font-mono">₹{calculationPreview.expenseAmount.toFixed(2)}</span></div>
                                <div className="flex justify-between items-center font-black text-lg py-2 border-y border-slate-800"><span className="text-emerald-400">Net Payout Pool</span><span className="font-mono text-emerald-400">₹{calculationPreview.netPool.toFixed(2)}</span></div>
                                {[7, 6, 5, 4, 3, 2, 1].map(lvl => (
                                    <div key={lvl} className="flex justify-between items-center text-sm"><span className="text-slate-400">{editConfig.levelNames[lvl as keyof typeof editConfig.levelNames]}</span><span className="font-mono">₹{calculationPreview.levelPayouts[lvl as keyof typeof editConfig.levels].toFixed(2)}</span></div>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {activeTab === 'user-sharing' && currentUser?.role === Role.ADMIN && (
                <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 h-[calc(100vh-18rem)]">
                    <div className="lg:col-span-1 bg-white rounded-xl border border-slate-200 shadow-sm flex flex-col overflow-hidden">
                        <div className="p-4 border-b border-slate-200 bg-slate-50">
                            <h3 className="font-bold text-slate-900 mb-3">Select User</h3>
                            <div className="relative">
                                <Search className="absolute left-3 top-2.5 text-slate-400 w-4 h-4" />
                                <input type="text" placeholder="Search user..." value={userSearch} onChange={e => setUserSearch(e.target.value)} className="w-full pl-10 pr-4 py-2 border rounded-lg text-sm bg-white" />
                            </div>
                        </div>
                        <div className="overflow-y-auto flex-1 divide-y divide-slate-100 dark:divide-slate-700/50">
                            {filteredTeam.map(member => (
                                <div
                                    key={member.id}
                                    className={`flex items-center justify-between group ${selectedUserForOverride?.id === member.id ? 'bg-blue-50 border-r-4 border-blue-600' : ''}`}
                                >
                                    <button
                                        onClick={() => handleSelectUserForOverride(member)}
                                        className="flex-1 text-left p-4 hover:bg-blue-50 transition"
                                    >
                                        <div className="font-bold text-slate-900 text-sm">{member.name}</div>
                                        <div className="text-[10px] text-slate-500 uppercase font-medium">{member.code} • Level {member.level}</div>
                                    </button>
                                    <div className="flex items-center gap-1 pr-2">
                                        <button
                                            onClick={() => { setResetPasswordModal({ userId: member.id, userName: member.name }); setResetPasswordValue(''); setResetPasswordConfirm(''); }}
                                            className="p-1.5 text-slate-300 hover:text-amber-500 hover:bg-amber-50 rounded transition"
                                            title="Reset Password"
                                        >
                                            <Key className="w-3.5 h-3.5" />
                                        </button>
                                        {member.customLevels ? (
                                            <span className="text-[9px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded-full font-black uppercase">Custom</span>
                                        ) : (
                                            <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-blue-400" />
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="lg:col-span-3 bg-white rounded-xl border border-slate-200 shadow-sm flex flex-col overflow-hidden">
                        {selectedUserForOverride ? (
                            <>
                                <div className="p-6 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
                                    <div>
                                        <h3 className="text-xl font-bold text-slate-900">Sharing Override: {selectedUserForOverride.name}</h3>
                                        <p className="text-sm text-slate-500 dark:text-slate-400">Customize the percentage of net brokerage this user's account receives at each level.</p>
                                    </div>
                                    <button onClick={() => setSelectedUserForOverride(null)} className="text-slate-400 hover:text-slate-600"><X className="w-6 h-6" /></button>
                                </div>
                                <div className="p-8 flex-1 overflow-y-auto space-y-8">
                                    <div className="bg-amber-50 border border-amber-200 p-4 rounded-lg flex items-start">
                                        <AlertCircle className="w-5 h-5 text-amber-600 mr-3 mt-0.5" />
                                        <div className="text-sm text-amber-800">
                                            <p className="font-bold">Important Notice</p>
                                            <p>These values override the global defaults only for this specific user. If a level is not required for this user's deal, set it to <strong>0%</strong>. Ensure the total adds up to <strong>100%</strong>.</p>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                                        <div className="space-y-4">
                                            <h4 className="font-black text-xs uppercase text-slate-400 tracking-widest">Percentage Distribution</h4>
                                            {[7, 6, 5, 4, 3, 2, 1].map(lvl => (
                                                <div key={lvl} className="flex items-center justify-between bg-slate-50 p-4 rounded-xl border border-slate-100">
                                                    <div>
                                                        <div className="font-bold text-slate-900">Level {lvl}</div>
                                                        <div className="text-[10px] text-slate-500 uppercase">{globalConfig.levelNames[lvl as keyof typeof globalConfig.levelNames]}</div>
                                                    </div>
                                                    <div className="flex items-center bg-white border rounded-lg shadow-inner overflow-hidden">
                                                        <input
                                                            type="number"
                                                            value={userOverrideLevels[lvl] || 0}
                                                            onChange={e => handleUserLevelChange(lvl, e.target.value)}
                                                            className="w-20 p-2 text-right font-black text-blue-600 focus:outline-none"
                                                        />
                                                        <span className="px-3 bg-slate-100 border-l text-slate-400 font-bold">%</span>
                                                    </div>
                                                </div>
                                            ))}
                                            {(() => {
                                                // Slices are % of gross. Whatever's left becomes company retention.
                                                // Valid range: 0..100 (the old "must equal 100" rule is gone).
                                                const totalPct = [1, 2, 3, 4, 5, 6, 7].reduce((acc, lvl) => acc + (userOverrideLevels[lvl] || 0), 0);
                                                const companyPct = Math.max(0, Math.round((100 - totalPct) * 100) / 100);
                                                const overflow = totalPct > 100.001;
                                                return (
                                                    <div className="space-y-2">
                                                        <div className="flex items-center justify-between p-4 bg-slate-900 text-white rounded-xl">
                                                            <span className="font-bold">Distributed to Team</span>
                                                            <span className={`text-xl font-black ${overflow ? 'text-red-400' : 'text-emerald-400'}`}>
                                                                {totalPct}%
                                                            </span>
                                                        </div>
                                                        <div className={`flex items-center justify-between p-3 rounded-xl border ${overflow ? 'bg-red-50 border-red-200 text-red-700' : 'bg-amber-50 border-amber-200 text-amber-800'}`}>
                                                            <span className="font-bold text-xs uppercase tracking-widest">Company Retention</span>
                                                            <span className="text-lg font-black">
                                                                {overflow ? 'Over-allocated' : `${companyPct}%`}
                                                            </span>
                                                        </div>
                                                        <p className="text-[10px] text-slate-500 leading-snug px-1">
                                                            Each level above is the % of <span className="font-bold">gross brokerage</span> that user receives.
                                                            Anything you don&apos;t allocate becomes company retention automatically.
                                                        </p>
                                                    </div>
                                                );
                                            })()}
                                        </div>

                                        <div className="space-y-6 text-slate-900 dark:text-slate-100">
                                            <h4 className="font-black text-xs uppercase text-slate-400 tracking-widest">Active Status</h4>
                                            <div className="space-y-4">
                                                {[7, 6, 5, 4, 3, 2, 1].map(lvl => (
                                                    <div key={lvl} className="flex items-center space-x-3">
                                                        <div className={`w-3 h-3 rounded-full ${userOverrideLevels[lvl] > 0 ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-slate-300'}`}></div>
                                                        <span className={`text-sm font-medium ${userOverrideLevels[lvl] > 0 ? 'text-slate-900' : 'text-slate-400 italic line-through'}`}>
                                                            Layer {lvl}: {userOverrideLevels[lvl] > 0 ? 'Included' : 'Bypassed / Not Required'}
                                                        </span>
                                                    </div>
                                                ))}
                                            </div>

                                            <div className="mt-8 pt-8 border-t border-slate-100 flex flex-col space-y-3">
                                                <button
                                                    onClick={handleSaveUserOverride}
                                                    className="w-full bg-blue-600 text-white font-bold py-3 rounded-xl shadow-lg shadow-blue-200 hover:bg-blue-700 transition flex items-center justify-center"
                                                >
                                                    <Save className="w-4 h-4 mr-2" /> Save Sharing Rule
                                                </button>
                                                {selectedUserForOverride.customLevels && (
                                                    <button
                                                        onClick={handleResetUserOverride}
                                                        className="w-full text-red-600 font-bold py-3 rounded-xl border border-red-100 hover:bg-red-50 transition flex items-center justify-center"
                                                    >
                                                        <Trash2 className="w-4 h-4 mr-2" /> Reset to Global Default
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </>
                        ) : (
                            <div className="flex-1 flex flex-col items-center justify-center p-20 text-slate-400">
                                <Users className="w-16 h-16 mb-4 opacity-20" />
                                <h3 className="text-xl font-bold text-slate-500">Userwise Sharing</h3>
                                <p className="text-center mt-2 max-w-sm">Select a team member from the list to set custom brokerage sharing percentages that override global rules.</p>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {activeTab === 'lead-source' && currentUser?.role === Role.ADMIN && (
              <>
                {/* ── Sharing model toggle ── */}
                <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm p-6 mb-6">
                    <h3 className="text-lg font-bold flex items-center mb-1"><GitBranch className="w-5 h-5 mr-2 text-blue-600" />Brokerage Sharing Model</h3>
                    {/* Model chooser REMOVED 2026-08-18. "Flat % of Gross" and "Cumulative"
                        both let the levels sum past 100%, so the firm could pay out more than
                        it received (one BM book ran at 103.46% of gross). Residual is now the
                        only model and is deliberately not switchable. */}
                    <p className="text-sm text-slate-500 mb-4">How every client&apos;s brokerage is split.</p>
                    <div className="p-4 rounded-xl border-2 border-blue-600 bg-blue-50 dark:bg-blue-900/30">
                        <div className="font-bold text-sm">Residual to Manager — the only model</div>
                        <div className="text-xs text-slate-600 dark:text-slate-300 mt-2 leading-relaxed">
                            Company keeps <strong>{editConfig.companyExpensePct ?? 0}%</strong> first. Then L1–L3 each take their
                            own percentage (sharing % plus the lead-source bonus). Whatever remains goes to the
                            <strong> L{(editConfig as any).residualLevel ?? 4} manager</strong>.
                        </div>
                        <div className="text-[11px] text-slate-500 mt-2">
                            Example: ₹100 → company ₹15 → RM ₹75 → manager gets the remaining <strong>₹10</strong>.
                            A manager&apos;s percentage is an <em>outcome</em>, not a setting — it moves with their downline.
                        </div>
                    </div>

                    {(editConfig as any).leadSharingModel === 'RESIDUAL' && (() => {
                        const rl = (editConfig as any).residualLevel ?? 4;
                        const company = editConfig.companyExpensePct ?? 15;
                        return (
                        <div className="mt-4 border-t border-slate-100 dark:border-slate-700 pt-4">
                            {/* Simple 3-step explanation of how ₹100 is split */}
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
                                <div className="rounded-xl border border-slate-200 dark:border-slate-600 p-4">
                                    <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Step 1 · Company</div>
                                    <div className="flex items-baseline gap-2">
                                        <input type="number" step="0.5" value={editConfig.companyExpensePct ?? ''} onChange={(e) => setEditConfig({ ...editConfig, companyExpensePct: parseFloat(e.target.value) || 0 })} className="w-20 border border-slate-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 p-2 rounded-lg font-black text-lg text-center focus:ring-2 focus:ring-blue-500" placeholder="15" />
                                        <span className="font-bold text-slate-500">% off the top</span>
                                    </div>
                                </div>
                                <div className="rounded-xl border border-slate-200 dark:border-slate-600 p-4">
                                    <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Step 2 · RMs</div>
                                    <div className="text-sm font-bold text-slate-700 dark:text-slate-200">Levels 1–{rl - 1} keep their own sharing %</div>
                                    <div className="text-[11px] text-slate-400 mt-1">(each RM's existing rate — unchanged)</div>
                                </div>
                                <div className="rounded-xl border border-slate-200 dark:border-slate-600 p-4">
                                    <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Step 3 · Surplus</div>
                                    <div className="text-sm font-bold text-slate-700 dark:text-slate-200">Whatever's left → nearest superior</div>
                                    <div className="text-[11px] text-slate-400 mt-1">flows up: L{rl} → L{Math.min(rl + 1, 7)} → L{Math.min(rl + 2, 7)}…</div>
                                </div>
                            </div>
                            <div className="flex items-center gap-3 mb-3">
                                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">RMs are levels 1 to</span>
                                <select value={rl - 1} onChange={(e) => setEditConfig({ ...editConfig, residualLevel: Number(e.target.value) + 1 } as any)} className="border border-slate-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 p-2 rounded-lg font-bold text-sm focus:ring-2 focus:ring-blue-500">
                                    {[1,2,3,4,5,6].map(l => <option key={l} value={l}>L{l}</option>)}
                                </select>
                                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">— superiors are above</span>
                            </div>
                            <div className="text-xs bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800 rounded-lg p-3 text-slate-600 dark:text-slate-300">
                                <b>Example on ₹100:</b> company keeps <b>₹{company}</b>. If the RM chain (L1–L{rl - 1}) takes 50%, the RM's nearest superior gets the remaining <b>₹{Math.max(0, 100 - company - 50)}</b>. If nobody is assigned above the RM on a client, that surplus stays with the company.
                            </div>
                        </div>
                        );
                    })()}
                </div>

                {/* ── Cumulative rates editor ── */}
                {editConfig.leadSharingModel === 'CUMULATIVE' && (
                <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm p-6 mb-6">
                    <h3 className="text-lg font-bold mb-1">Designation Cumulative Rates</h3>
                    <p className="text-sm text-slate-500 mb-4 max-w-3xl">Cumulative % per level (must increase by level). A person earns <span className="font-semibold">their level's cumulative − the level below them</span>. Company keeps <span className="font-semibold">100% − the highest level reached</span>.</p>
                    <div className="mb-5 flex items-center gap-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3">
                        <span className="text-xs font-black uppercase tracking-widest text-amber-700">Lead Source base %</span>
                        <input type="number" min="0" value={editConfig.leadSourcePct ?? 0} onChange={(e) => handleLeadPctChange(e.target.value)} className="w-20 p-2 text-right text-sm font-bold bg-white dark:bg-slate-700 border border-amber-300 rounded" />
                        <span className="text-xs text-amber-700">credited to whoever sourced the lead (default: lowest level = self-sourced).</span>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead><tr className="text-[10px] uppercase tracking-widest text-slate-500">
                                <th className="text-left p-2">Level</th>
                                {[1,2,3,4,5,6,7].map(l => <th key={l} className="p-2 text-center">L{l}<div className="font-normal normal-case text-[9px] text-slate-400 truncate max-w-[80px]">{editConfig.levelNames?.[l as keyof typeof editConfig.levelNames] || ''}</div></th>)}
                            </tr></thead>
                            <tbody>
                                <tr>
                                    <td className="p-2 font-bold text-slate-500">Cumulative %</td>
                                    {[1,2,3,4,5,6,7].map(l => (
                                        <td key={l} className="p-1 text-center">
                                            <input type="number" min="0" value={(editConfig.designationCumulative as any)?.[l] ?? ''} placeholder="0" onChange={(e) => handleCumulativeChange(l, e.target.value)} className="w-16 p-1.5 text-right text-sm font-bold bg-slate-50 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded" />
                                        </td>
                                    ))}
                                </tr>
                                <tr className="text-[11px] text-slate-400">
                                    <td className="p-2">Incremental (gap)</td>
                                    {[1,2,3,4,5,6,7].map(l => {
                                        const c = editConfig.designationCumulative || {};
                                        let prev = 0; for (let k = l - 1; k >= 1; k--) { if ((c as any)[k]) { prev = Number((c as any)[k]); break; } }
                                        const cur = Number((c as any)[l]) || 0;
                                        return <td key={l} className="p-2 text-center font-mono">{cur ? `${(cur - prev)}%` : '–'}</td>;
                                    })}
                                </tr>
                            </tbody>
                        </table>
                    </div>
                    {!cumulativeMonotonicOk && <p className="text-xs text-red-500 mt-3 font-semibold">Rates must increase by level and stay ≤ 100%.</p>}
                    <div className="flex justify-end mt-5">
                        <button onClick={handleLeadSourceSave} disabled={!cumulativeMonotonicOk} className="flex items-center px-5 py-2.5 bg-blue-600 text-white rounded-lg font-bold text-sm hover:bg-blue-700 disabled:opacity-50"><Save className="w-4 h-4 mr-2" />Save Model & Rates</button>
                    </div>
                </div>
                )}

              </>
            )}

            {activeTab === 'activity' && currentUser?.role === Role.ADMIN && (
                <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
                    <div className="p-6 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <div>
                            <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100 flex items-center"><ClipboardList className="w-5 h-5 mr-2 text-slate-500" />Activity Log</h3>
                            <p className="text-sm text-slate-500 mt-1">System-wide audit trail of user actions.</p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            <div className="relative">
                                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                                <input
                                    type="text"
                                    value={activitySearch}
                                    onChange={e => setActivitySearch(e.target.value)}
                                    placeholder="Search activity..."
                                    className="pl-9 pr-4 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none w-48"
                                />
                            </div>
                            <input
                                type="date"
                                value={activityFromDate}
                                onChange={e => setActivityFromDate(e.target.value)}
                                className="py-2 px-3 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                                title="From date"
                            />
                            <input
                                type="date"
                                value={activityToDate}
                                onChange={e => setActivityToDate(e.target.value)}
                                className="py-2 px-3 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                                title="To date"
                            />
                            {(activityFromDate || activityToDate) && (
                                <button onClick={() => { setActivityFromDate(''); setActivityToDate(''); }} className="text-xs text-slate-400 hover:text-red-500 transition">Clear</button>
                            )}
                            <button onClick={fetchActivityLog} disabled={activityLoading} className="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition">
                                <RefreshCcw className={`w-4 h-4 ${activityLoading ? 'animate-spin' : ''}`} />
                            </button>
                        </div>
                    </div>

                    <div className="max-h-[600px] overflow-y-auto">
                        {activityLoading ? (
                            <div className="flex items-center justify-center py-16">
                                <Loader2 className="w-6 h-6 text-blue-500 animate-spin" />
                                <span className="ml-3 text-sm text-slate-500 font-medium">Loading activity...</span>
                            </div>
                        ) : filteredActivityLog.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-16 text-center">
                                <ClipboardList className="w-10 h-10 text-slate-200 mb-3" />
                                <h4 className="text-slate-600 font-bold text-sm">No Activity Recorded</h4>
                                <p className="text-slate-400 text-xs mt-1 max-w-[250px]">
                                    {activitySearch ? 'No entries match your search.' : 'User actions will appear here as they happen.'}
                                </p>
                            </div>
                        ) : (
                            <div className="divide-y divide-slate-50">
                                {filteredActivityLog.slice(0, 100).map((entry: any, idx: number) => (
                                    <div key={entry.id || idx} className="px-6 py-4 hover:bg-slate-50 transition flex items-start gap-4">
                                        <div className="w-8 h-8 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">
                                            {(entry.userName || '?').charAt(0).toUpperCase()}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2">
                                                <span className="text-sm font-bold text-slate-900">{entry.userName || 'System'}</span>
                                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest bg-slate-100 text-slate-500">{entry.action || 'action'}</span>
                                            </div>
                                            <p className="text-sm text-slate-600 mt-0.5 truncate">{entry.description || '—'}</p>
                                        </div>
                                        <div className="flex items-center gap-1 text-slate-400 shrink-0">
                                            <Clock className="w-3 h-3" />
                                            <span className="text-[10px] font-bold uppercase tracking-wider whitespace-nowrap">{formatRelativeTime(entry.createdAt)}</span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {filteredActivityLog.length > 0 && (
                        <div className="px-6 py-3 border-t border-slate-100 bg-slate-50">
                            <span className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">
                                Showing {Math.min(100, filteredActivityLog.length)} of {filteredActivityLog.length} entries
                            </span>
                        </div>
                    )}
                </div>
            )}

            {activeTab === 'system' && currentUser?.role === Role.ADMIN && (
                <div className="max-w-2xl bg-white rounded-xl border border-red-100 shadow-sm overflow-hidden">
                    <div className="p-6 bg-red-50 border-b border-red-100">
                        <h3 className="text-red-800 font-bold flex items-center"><AlertTriangle className="w-5 h-5 mr-2" /> Danger Zone</h3>
                    </div>
                    <div className="p-8 border-b border-slate-100">
                        <h4 className="font-bold text-slate-900 mb-2">Recalculate Payouts</h4>
                        <p className="text-sm text-slate-600 mb-6">Forces the system to re-run the sharing logic on all imported transactions using the current global and user-specific rules.</p>
                        <button
                            onClick={handleManualRecalculate}
                            disabled={isRecalculating}
                            className="bg-blue-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-blue-700 transition shadow-lg shadow-blue-100 flex items-center font-black uppercase tracking-widest text-[10px] disabled:opacity-50"
                        >
                            {isRecalculating ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCcw className="w-4 h-4 mr-2" />}
                            {isRecalculating ? 'Recalculating...' : 'Recalculate All Transactions'}
                        </button>
                    </div>
                    <LockMonths />
                    {/* A folio belongs to one investor at one fund house, so one client
                        record should claim it. Here single folios are claimed by 80+
                        records, which is why a re-import could attach a month's rows to
                        a different person than last time. The importer now breaks the tie
                        on the investor's name; this removes the wrong claims for good. */}
                    <div className="p-8 border-b border-slate-100">
                        <h4 className="font-bold text-slate-900 mb-2">Folio ownership</h4>
                        <p className="text-sm text-slate-600 mb-4">
                            Finds folios claimed by more than one client and removes the claim from every record
                            that is not the owner. The owner is decided from the investor name on that folio&rsquo;s own
                            statements &mdash; and only when exactly one claimant matches it. Anything less certain is
                            listed for you rather than guessed at. Folios are never added to a record.
                        </p>
                        <div className="flex items-center gap-3 flex-wrap">
                            <button
                                onClick={async () => {
                                    setFolioBusy(true); setFolioResult(null);
                                    try {
                                        const r = await authFetch('/api/data', {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ action: 'folio_conflicts', payload: { apply: false } }),
                                        });
                                        const j = await r.json();
                                        if (!r.ok) { showToast(j?.error || 'Check failed.', 'error'); return; }
                                        setFolioResult(j);
                                    } catch (e: any) {
                                        // A timeout or a proxy error page is not JSON. Say so
                                        // rather than failing silently.
                                        showToast(`Check did not finish (${e?.message || 'no response'}). Nothing was changed.`, 'error');
                                    } finally { setFolioBusy(false); }
                                }}
                                disabled={folioBusy}
                                className="bg-slate-800 text-white px-5 py-3 rounded-xl font-black uppercase tracking-widest text-[10px] hover:bg-slate-900 transition disabled:opacity-50 flex items-center"
                            >
                                {folioBusy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Search className="w-4 h-4 mr-2" />}
                                Check only
                            </button>
                            <button
                                onClick={async () => {
                                    const confirmed = await showConfirm({
                                        title: 'Clean up folio ownership?',
                                        message: `This removes ${folioResult?.claimsToRemove ?? 'the'} wrong folio claim(s) from client records. Transactions are not touched; re-run Recalculate afterwards so the reports follow.`,
                                        confirmText: 'Clean up',
                                        variant: 'warning',
                                    });
                                    if (!confirmed) return;
                                    setFolioBusy(true);
                                    try {
                                        const r = await authFetch('/api/data', {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ action: 'folio_conflicts', payload: { apply: true } }),
                                        });
                                        const j = await r.json();
                                        if (!r.ok) { showToast(j?.error || 'Clean-up failed.', 'error'); return; }
                                        setFolioResult(j);
                                        showToast(`Removed ${j.foliosRemoved} claim(s) from ${j.recordsChanged} client record(s).`, 'success');
                                    } catch (e: any) {
                                        showToast(`Clean-up did not finish (${e?.message || 'no response'}). Run Check only again to see what is left.`, 'error');
                                    } finally { setFolioBusy(false); }
                                }}
                                disabled={folioBusy || !folioResult || !folioResult.claimsToRemove}
                                className="bg-blue-600 text-white px-5 py-3 rounded-xl font-black uppercase tracking-widest text-[10px] hover:bg-blue-700 transition disabled:opacity-40 flex items-center"
                            >
                                <GitBranch className="w-4 h-4 mr-2" /> Clean up
                            </button>
                        </div>
                        <div className="mt-6 pt-5 border-t border-slate-100">
                            <h5 className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">Assign folios to one RM</h5>
                            <p className="text-xs text-slate-500 mb-3">
                                When AdvisorKhoj splits one investor between two RMs by folio, say which RM each folio belongs to. The folio stays on that RM&rsquo;s
                                record and leaves every other. Optionally the chosen month&rsquo;s rows move too, so the report corrects without re-uploading the month.
                            </p>
                            <textarea
                                value={faFolios}
                                onChange={e => setFaFolios(e.target.value)}
                                rows={2}
                                aria-label="Folios to assign"
                                placeholder="Folios, separated by commas or new lines"
                                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm font-mono bg-white mb-3"
                            />
                            <div className="flex items-center gap-3 flex-wrap">
                                <select value={faRm} onChange={e => setFaRm(e.target.value)} aria-label="RM who owns these folios"
                                    className="px-3 py-2 rounded-lg border border-slate-200 text-sm font-bold bg-white">
                                    <option value="">Belongs to&hellip;</option>
                                    {[...team].sort((a, b) => a.name.localeCompare(b.name)).map(t => <option key={t.id} value={t.id}>{t.name.trim()} (L{t.level})</option>)}
                                </select>
                                <select value={faMonth} onChange={e => setFaMonth(e.target.value)} aria-label="Month whose existing rows should move"
                                    className="px-3 py-2 rounded-lg border border-slate-200 text-sm font-bold bg-white">
                                    <option value="">Do not move any rows</option>
                                    {Array.from({ length: 8 }, (_, i) => {
                                        const d = new Date(new Date().getFullYear(), new Date().getMonth() - i, 1);
                                        const v = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
                                        return <option key={v} value={v}>Also move {v} rows</option>;
                                    })}
                                </select>
                                <button onClick={runAssignForm} disabled={faBusy || !faFolios.trim() || !faRm}
                                    className="bg-blue-600 text-white px-5 py-2.5 rounded-xl font-black uppercase tracking-widest text-[10px] hover:bg-blue-700 transition disabled:opacity-40 flex items-center">
                                    {faBusy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <GitBranch className="w-4 h-4 mr-2" />} Assign
                                </button>
                            </div>
                            {faResult && (
                                <div className="mt-3 text-xs text-slate-700 space-y-1">
                                    <p><b>{faResult.assigned}</b> folio(s) assigned, {faResult.foliosRemoved} claim(s) removed from {faResult.recordsChanged} record(s){faMonth ? `, ${faResult.rowsMoved} row(s) moved` : ''}.</p>
                                    {!!faResult.skipped?.length && (
                                        <p className="text-amber-700">Skipped: {faResult.skipped.map((x: any) => `${x.folio} (${x.why})`).join('; ')}</p>
                                    )}
                                    {!!faResult.movedFrom?.length && (
                                        <details>
                                            <summary className="cursor-pointer font-black uppercase tracking-widest text-slate-400 text-[10px]">Where those rows were sitting</summary>
                                            <ul className="mt-1 list-disc ml-4">
                                                {faResult.movedFrom.map((m: any, i: number) => (
                                                    <li key={i}><span className="font-mono">{m.folio}</span>: {m.rows} row(s), &#8377;{Number(m.gross).toLocaleString('en-IN')} were on <b>{m.from}</b></li>
                                                ))}
                                            </ul>
                                        </details>
                                    )}
                                    <p className="text-slate-500">Reports update at once. Run Recalculate above for payout earnings.</p>
                                </div>
                            )}
                        </div>
                        {folioResult && (
                            <div className="mt-5 text-sm text-slate-700 space-y-1">
                                <p><b>{folioResult.foliosConflicted}</b> of {folioResult.foliosTotal} folios are claimed by more than one client.</p>
                                <p><b>{folioResult.resolvable}</b> can be settled from the statements &mdash; {folioResult.claimsToRemove} wrong claim(s) to remove
                                    {folioResult.truncatedFolios > 0 && <> (of which {folioResult.truncatedFolios} are folios Excel truncated, e.g. 477413000000)</>}.</p>
                                <p><b>{folioResult.duplicatesSameRm ?? 0}</b> are the same investor filed more than once under the <i>same</i> RM &mdash; harmless, the importer now handles them.</p>
                                <p className={folioResult.duplicatesDifferentRm ? 'text-red-700 font-bold' : ''}>
                                    <b>{folioResult.duplicatesDifferentRm ?? 0}</b> are the same investor under <i>different</i> RMs &mdash; you decide who owns them.
                                </p>
                                {folioResult.apply && (
                                    <p className="text-emerald-700 font-bold">
                                        Done: {folioResult.foliosRemoved} claim(s) removed from {folioResult.recordsChanged} record(s).
                                        Run Recalculate above so the reports follow.
                                    </p>
                                )}
                                {!!folioResult.sampleUnresolved?.length && (
                                    <details className="mt-2">
                                        <summary className="cursor-pointer text-xs font-black uppercase tracking-widest text-slate-400">
                                            The ones that need your decision
                                        </summary>
                                        <ul className="mt-2 text-xs text-slate-600 space-y-0.5">
                                            {folioResult.sampleUnresolved.map((u: any) => (
                                                <li key={u.folio}>
                                                    <span className="font-mono">{u.folio}</span> &mdash; {u.why}{u.investor ? ` (statements say "${u.investor}")` : ''}
                                                    {Array.isArray(u.records) && (
                                                        <ul className="ml-4 list-disc">
                                                            {u.records.map((r: any, i: number) => (
                                                                <li key={i}>{r.name} &rarr; RM <b>{r.rm}</b>{r.bm ? `, BM ${r.bm}` : ''}</li>
                                                            ))}
                                                        </ul>
                                                    )}
                                                    {Array.isArray(u.records) && (
                                                        <div className="ml-4 mt-1 mb-2 flex gap-2 flex-wrap">
                                                            {[...new Map<string, string>(u.records.filter((r: any) => r.rmId).map((r: any) => [r.rmId, r.rm] as [string, string])).entries()].map(([rmId, rm]) => (
                                                                <button
                                                                    key={rmId}
                                                                    disabled={folioBusy}
                                                                    onClick={() => assignFolio(u.folio, rmId, rm)}
                                                                    className="px-2.5 py-1 rounded-lg border border-slate-300 text-[10px] font-black uppercase tracking-widest text-slate-600 hover:border-blue-500 hover:text-blue-600 disabled:opacity-40"
                                                                >
                                                                    Folio belongs to {rm}
                                                                </button>
                                                            ))}
                                                        </div>
                                                    )}
                                                </li>
                                            ))}
                                        </ul>
                                    </details>
                                )}
                            </div>
                        )}
                    </div>
                    {/* When a BM is promoted and a new firm is made the BM beneath them, the RMs and
                        clients that sat under the old BM have to follow. This does it in one go instead
                        of one client at a time. */}
                    <div className="p-8 border-b border-slate-100">
                        <h4 className="font-bold text-slate-900 mb-2">Branch restructure</h4>
                        <p className="text-sm text-slate-600 mb-4">
                            Use when a manager is promoted and a new BM is placed beneath them. Everyone who reports to the first person
                            is moved to report to the second, and clients that sat under the first with <b>no manager at the second&rsquo;s level</b> get
                            the second placed there. A slot that is already filled is never overwritten. Check first, it changes nothing.
                        </p>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
                            <div>
                                <label htmlFor="br-from" className="block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">Everyone currently under</label>
                                <select id="br-from" value={brFrom} onChange={e => { setBrFrom(e.target.value); setBrResult(null); }}
                                    className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm font-bold bg-white">
                                    <option value="">Choose a person</option>
                                    {[...team].sort((a, b) => a.name.localeCompare(b.name)).map(t => <option key={t.id} value={t.id}>{t.name.trim()} (L{t.level})</option>)}
                                </select>
                            </div>
                            <div>
                                <label htmlFor="br-to" className="block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">Move them under</label>
                                <select id="br-to" value={brTo} onChange={e => { setBrTo(e.target.value); setBrResult(null); }}
                                    className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm font-bold bg-white">
                                    <option value="">Choose a person</option>
                                    {[...team].sort((a, b) => a.name.localeCompare(b.name)).map(t => <option key={t.id} value={t.id}>{t.name.trim()} (L{t.level})</option>)}
                                </select>
                            </div>
                        </div>
                        <div className="flex items-center gap-3 flex-wrap">
                            <button onClick={() => runBranch(false)} disabled={brBusy || !brFrom || !brTo}
                                className="bg-slate-800 text-white px-5 py-3 rounded-xl font-black uppercase tracking-widest text-[10px] hover:bg-slate-900 transition disabled:opacity-50 flex items-center">
                                {brBusy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Search className="w-4 h-4 mr-2" />} Check only
                            </button>
                            <button onClick={() => runBranch(true)} disabled={brBusy || !brResult || (!brResult.clients && !brResult.teamMembers?.length) || brResult.apply}
                                className="bg-blue-600 text-white px-5 py-3 rounded-xl font-black uppercase tracking-widest text-[10px] hover:bg-blue-700 transition disabled:opacity-40 flex items-center">
                                <GitBranch className="w-4 h-4 mr-2" /> Move branch
                            </button>
                        </div>
                        {brResult && (
                            <div className="mt-5 text-sm text-slate-700 space-y-1">
                                <p><b>{brResult.clients}</b> client(s) will get <b>{brResult.to}</b> placed at L{brResult.level}.</p>
                                <p><b>{brResult.teamMembers?.length ?? 0}</b> team member(s) will report to <b>{brResult.to}</b>{brResult.teamMembers?.length ? ': ' + brResult.teamMembers.map((m: any) => `${m.name.trim()} (L${m.level})`).join(', ') : ''}.</p>
                                {brResult.skipped > 0 && <p className="text-amber-700"><b>{brResult.skipped}</b> client(s) already have someone at that level and are left alone.</p>}
                                {!!brResult.sampleClients?.length && (
                                    <details className="mt-2">
                                        <summary className="cursor-pointer text-xs font-black uppercase tracking-widest text-slate-400">The clients</summary>
                                        <p className="mt-2 text-xs text-slate-600">{brResult.sampleClients.join(', ')}</p>
                                    </details>
                                )}
                                <p className="text-xs text-slate-500 pt-1">This applies to every month, not only the latest. It does not recalculate payouts; do that yourself once you have looked at the result.</p>
                            </div>
                        )}
                    </div>
                    <div className="p-8">
                        <h4 className="font-bold text-slate-900 mb-2">System Reset</h4>
                        <p className="text-sm text-slate-600 mb-6">Clearing the data will permanently delete all imported transactions, clients, and custom team members from your local browser storage. This action is irreversible.</p>
                        <button onClick={async () => {
                            const confirmed = await showConfirm({
                                title: 'Factory Reset Application',
                                message: 'CRITICAL: This will permanently delete ALL data — transactions, clients, team members, and settings. This action cannot be undone.',
                                confirmText: 'Delete Everything',
                                variant: 'danger'
                            });
                            if (confirmed) clearAllData();
                        }} className="bg-red-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-red-700 transition shadow-lg shadow-red-100 flex items-center font-black uppercase tracking-widest text-[10px]"><Trash2 className="w-4 h-4 mr-2" /> Factory Reset Application</button>
                    </div>
                </div>
            )}
        </div>

        {/* Password Reset Modal */}
        {resetPasswordModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
                <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-6">
                    <div className="flex items-center justify-between mb-4">
                        <h3 className="font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                            <Key className="w-4 h-4 text-amber-500" />
                            Reset Password — {resetPasswordModal.userName}
                        </h3>
                        <button onClick={() => setResetPasswordModal(null)} className="text-slate-400 hover:text-slate-600">
                            <X className="w-5 h-5" />
                        </button>
                    </div>
                    <div className="space-y-3">
                        <div>
                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">New Password</label>
                            <input
                                type="password"
                                value={resetPasswordValue}
                                onChange={e => setResetPasswordValue(e.target.value)}
                                className="w-full border border-slate-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 p-3 rounded-xl mt-1 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                                placeholder="Min 6 characters"
                            />
                        </div>
                        <div>
                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Confirm Password</label>
                            <input
                                type="password"
                                value={resetPasswordConfirm}
                                onChange={e => setResetPasswordConfirm(e.target.value)}
                                className={`w-full border p-3 rounded-xl mt-1 text-sm focus:ring-2 focus:ring-blue-500 outline-none dark:bg-slate-700 dark:text-slate-100 ${resetPasswordConfirm && resetPasswordValue !== resetPasswordConfirm ? 'border-red-400' : 'border-slate-200 dark:border-slate-600'}`}
                                placeholder="Repeat password"
                            />
                            {resetPasswordConfirm && resetPasswordValue !== resetPasswordConfirm && (
                                <p className="text-red-500 text-xs mt-1">Passwords do not match</p>
                            )}
                        </div>
                    </div>
                    <div className="flex gap-3 mt-5">
                        <button onClick={() => setResetPasswordModal(null)} className="flex-1 px-4 py-2.5 border border-slate-200 rounded-xl text-sm font-bold text-slate-600 hover:bg-slate-50 transition">
                            Cancel
                        </button>
                        <button
                            onClick={handlePasswordReset}
                            disabled={resetPasswordLoading || resetPasswordValue.length < 6 || resetPasswordValue !== resetPasswordConfirm}
                            className="flex-1 px-4 py-2.5 bg-amber-500 text-white rounded-xl text-sm font-bold hover:bg-amber-600 disabled:opacity-50 transition flex items-center justify-center gap-2"
                        >
                            {resetPasswordLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                            Reset Password
                        </button>
                    </div>
                </div>
            </div>
        )}
        </>
    );
};
