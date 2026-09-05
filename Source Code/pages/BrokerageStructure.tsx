
import React, { useState, useEffect, useMemo } from 'react';
import { Upload, FileText, Download, Trash2, Search, Loader2, CheckCircle, AlertCircle, Edit, Save, X, RefreshCw } from 'lucide-react';
import { TeamMember, Role } from '../types';
import { useData, authFetch } from '../contexts/DataContext';
import { Pagination } from '../components/Pagination';
import { useToast } from '../components/Toast';

interface BrokerageStructureProps {
    currentUser: TeamMember;
}

interface BrokerageRow {
    id: string;
    amcName: string;
    schemeName: string;
    category: string;
    trailRate: number;
    finalRate: number;
    period: string;
    createdAt?: string;
    updatedAt?: string;
}

interface ExtractionStats {
    total: number;
    inserted: number;
    skipped: number;
}

interface FileStat {
    fileName: string;
    extractedRows: number;
    encrypted?: boolean;
    /** Lines in the PDF that look like schemes but produced no row — shown so a
     *  partial extraction is visible immediately instead of being found by hand. */
    unparsed?: string[];
}

interface EditValues {
    schemeName: string;
    trailRate: number | string;
}

export const BrokerageStructure: React.FC<BrokerageStructureProps> = ({ currentUser }) => {
    const [files, setFiles] = useState<File[]>([]);
    const [loading, setLoading] = useState(false);
    const { globalConfig } = useData();
    const { showToast, showConfirm } = useToast();
    const [data, setData] = useState<BrokerageRow[]>([]);
    const [search, setSearch] = useState('');
    const [stats, setStats] = useState<ExtractionStats | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [previewData, setPreviewData] = useState<BrokerageRow[]>([]);
    const [selectedAmc, setSelectedAmc] = useState('');
    const [selectedMonth, setSelectedMonth] = useState((new Date().getMonth() + 1).toString().padStart(2, '0'));
    const [selectedYear, setSelectedYear] = useState(new Date().getFullYear().toString());
    const [monthFilter, setMonthFilter] = useState('ALL');
    const [yearFilter, setYearFilter] = useState('ALL');
    // AMCs revise their structure, so the same scheme legitimately exists once per
    // effective month (e.g. Axis Aggressive Hybrid 1.25 for 2026-03, 1.06 for
    // 2026-07). Listing every version together made one scheme look like it had
    // several conflicting rates. Default to the CURRENT rate — one row per scheme —
    // and let the user switch this off to see the full rate history.
    const [latestOnly, setLatestOnly] = useState(true);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editValues, setEditValues] = useState<EditValues>({ schemeName: '', trailRate: 0 });
    const [historyModal, setHistoryModal] = useState<{ masterId: string; schemeName: string; rows: any[] } | null>(null);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [extractElapsed, setExtractElapsed] = useState(0);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [amcFilter, setAmcFilter] = useState('ALL');
    const [currentPage, setCurrentPage] = useState(1);
    const [fileStats, setFileStats] = useState<FileStat[]>([]);
    const [extractionWarnings, setExtractionWarnings] = useState<string[]>([]);
    const pageSize = 50;

    const isAdmin = currentUser.role === Role.ADMIN;

    useEffect(() => {
        fetchData();
    }, []);

    const fetchData = async () => {
        try {
            const res = await authFetch('/api/brokerage/list');
            const json = await res.json();
            setData(Array.isArray(json) ? json : []);
        } catch (err) {
            console.error('Failed to fetch brokerage data', err);
            showToast('Failed to load brokerage data.', 'error');
        }
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files) {
            setFiles(Array.from(e.target.files));
        }
        setError(null);
    };

    const handleExtract = async () => {
        if (files.length === 0) return;
        setLoading(true);
        setError(null);
        setStats(null);
        setPreviewData([]);
        setFileStats([]);
        setExtractionWarnings([]);

        const formData = new FormData();
        files.forEach(file => formData.append('files', file));

        try {
            const controller = new AbortController();
            const timeoutId = window.setTimeout(() => controller.abort(), 120000);
            let res: Response;
            try {
                res = await authFetch('/api/parse-brokerage', {
                    method: 'POST',
                    body: formData,
                    signal: controller.signal
                });
            } finally {
                window.clearTimeout(timeoutId);
            }

            const raw = await res.text();
            let result: any = {};
            if (raw) {
                try { result = JSON.parse(raw); } catch { result = {}; }
            }

            if (result.success) {
                setPreviewData(result.extracted || []);
                setFileStats(result.fileStats || []);
                setExtractionWarnings(result.warnings || []);
                setFiles([]);
                showToast(`Extracted ${result.extracted?.length || 0} rows from ${result.fileStats?.length || files.length} file(s).`, 'success');
            } else {
                setFileStats(result.fileStats || []);
                setExtractionWarnings(result.warnings || []);
                const errMsg = result.error || `Parsing failed (HTTP ${res.status})`;
                setError(errMsg);
                showToast(errMsg, 'error');
            }
        } catch (err: any) {
            if (err?.name === 'AbortError') {
                setError('Parsing timed out. Try a smaller file set or retry.');
                showToast('Parsing timed out. Please retry.', 'warning');
            } else {
                const msg = 'Network error during parsing. Ensure frontend (5173) and API server (3000) are running.';
                setError(msg);
                showToast(msg, 'error');
            }
        } finally {
            setLoading(false);
        }
    };

    const handleSaveToMaster = async () => {
        if (previewData.length === 0) return;

        // Pre-save validation
        const invalidRows = previewData.filter(row => {
            const name = (row.schemeName || '').trim();
            const rate = Number(row.trailRate || row.finalRate) || 0;
            return name.length < 8 || rate <= 0 || rate > 3.5;
        });
        if (invalidRows.length > 0) {
            const proceed = await showConfirm({
                title: 'Validation Warning',
                message: `${invalidRows.length} row(s) have unusual data (names too short or rates out of normal range 0.01–3.5%). Review before saving, or proceed anyway.`,
                confirmText: 'Save Anyway',
                variant: 'danger'
            });
            if (!proceed) return;
        }

        // Duplicate warning
        const existingIds = new Set(data.map((d) => d.id));
        const dupCount = previewData.filter(row => existingIds.has(row.id)).length;
        if (dupCount > 0) {
            const proceed = await showConfirm({
                title: 'Overwrite Warning',
                message: `${dupCount} scheme(s) already exist in the master list and will be overwritten with new rates. Continue?`,
                confirmText: `Overwrite ${dupCount} Scheme(s)`,
                variant: 'danger'
            });
            if (!proceed) return;
        }

        setLoading(true);
        try {
            const res = await authFetch('/api/data', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    collection: 'brokerage_masters',
                    payload: previewData.map(row => {
                        const { id, ...rest } = row;
                        const tr = Number(rest.trailRate || rest.finalRate) || 0;
                        return {
                            ...rest,
                            amcName: selectedAmc || rest.amcName,
                            trailRate: tr,
                            finalRate: tr,
                            period: `${selectedYear}-${selectedMonth}`
                        };
                    })
                })
            });
            const result = await res.json();
            if (result.success) {
                setStats({ total: 1, inserted: previewData.length, skipped: 0 });
                setPreviewData([]);
                fetchData();
            } else {
                setError(result.error || 'Save failed');
            }
        } catch (err) {
            setError('Failed to save to master');
        } finally {
            setLoading(false);
        }
    };

    const startEditing = (row: BrokerageRow) => {
        setEditingId(row.id);
        setEditValues({
            schemeName: row.schemeName,
            trailRate: row.finalRate || row.trailRate
        });
    };

    const cancelEditing = () => {
        setEditingId(null);
        setEditValues({ schemeName: '', trailRate: 0 });
    };

    const fetchHistory = async (row: BrokerageRow) => {
        setHistoryLoading(true);
        setHistoryModal({ masterId: row.id, schemeName: row.schemeName, rows: [] });
        try {
            const token = localStorage.getItem('wf_token');
            const res = await fetch(`/api/brokerage/${encodeURIComponent(row.id)}/history`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const history = res.ok ? await res.json() : [];
            setHistoryModal({ masterId: row.id, schemeName: row.schemeName, rows: history });
        } catch {
            setHistoryModal({ masterId: row.id, schemeName: row.schemeName, rows: [] });
        } finally {
            setHistoryLoading(false);
        }
    };

    useEffect(() => {
        if (!loading) { setExtractElapsed(0); return; }
        setExtractElapsed(0);
        const timer = setInterval(() => setExtractElapsed(s => s + 1), 1000);
        return () => clearInterval(timer);
    }, [loading]);

    const handleSaveEdit = async (id: string, isPreview = false) => {
        if (isPreview) {
            const rate = Number(editValues.trailRate);
            setPreviewData(prev => prev.map(row =>
                row.id === id ? { ...row, schemeName: editValues.schemeName, trailRate: rate, finalRate: rate } : row
            ));
            setEditingId(null);
        } else {
            setLoading(true);
            try {
                const existingRow = data.find(r => r.id === id);
                const res = await authFetch('/api/data', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        collection: 'brokerage_masters',
                        payload: {
                            ...existingRow,
                            schemeName: editValues.schemeName,
                            trailRate: Number(editValues.trailRate),
                            updatedAt: new Date().toISOString()
                        }
                    })
                });
                if (!res.ok) throw new Error('Update failed');
                setEditingId(null);
                fetchData();
            } catch (err) {
                console.error('Update failed', err);
                showToast('Failed to update scheme.', 'error');
            } finally {
                setLoading(false);
            }
        }
    };

    const handleDeletePreviewRow = (id: string) => {
        setPreviewData(prev => prev.filter(row => row.id !== id));
    };

    const handleExport = async () => {
        try {
            setLoading(true);
            const params = new URLSearchParams();
            if (amcFilter !== 'ALL') params.append('amcName', amcFilter);
            if (monthFilter !== 'ALL') params.append('month', monthFilter);
            if (yearFilter !== 'ALL') params.append('year', yearFilter);

            const res = await authFetch(`/api/brokerage/export.csv?${params.toString()}`);
            if (!res.ok) {
                const errorData = await res.json().catch(() => ({}));
                throw new Error(errorData.error || 'Export failed');
            }
            const blob = await res.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `brokerage_master_export_${new Date().toISOString().split('T')[0]}.csv`;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            document.body.removeChild(a);
            showToast('CSV exported successfully.', 'success');
        } catch (err: any) {
            console.error('Export failed', err);
            showToast(err.message || 'Failed to export CSV.', 'error');
        } finally {
            setLoading(false);
        }
    };

    const handleReset = async () => {
        const confirmed = await showConfirm({
            title: 'Reset Master Data?',
            message: 'This will permanently clear all master brokerage data. This action cannot be undone.',
            confirmText: 'Clear All Data',
            variant: 'danger'
        });
        if (!confirmed) return;
        try {
            await authFetch('/api/brokerage/reset', { method: 'POST' });
            fetchData();
            setStats(null);
            showToast('Master data reset successful.', 'success');
        } catch (err) {
            console.error('Reset failed');
            showToast('Failed to reset master data.', 'error');
        }
    };

    const handleDeleteRow = async (id: string) => {
        const confirmed = await showConfirm({
            title: 'Delete Scheme?',
            message: 'Are you sure you want to remove this scheme from the master list?',
            confirmText: 'Delete',
            variant: 'danger'
        });
        if (!confirmed) return;
        setLoading(true);
        try {
            const res = await authFetch('/api/data', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'bulk_delete',
                    collection: 'brokerage_masters',
                    payload: [id]
                })
            });
            if (!res.ok) throw new Error('Delete failed');
            const result = await res.json();
            if (result.count > 0) {
                showToast('Scheme removed successfully.', 'success');
            } else {
                showToast('Scheme was already removed or not found.', 'warning');
            }
            fetchData();
        } catch (err) {
            console.error('Delete failed:', err);
            showToast('Failed to delete scheme.', 'error');
        } finally {
            setLoading(false);
        }
    };

    const handleBulkDelete = async () => {
        if (!selectedIds.size) return;
        const confirmed = await showConfirm({
            title: 'Bulk Delete Schemes?',
            message: `Delete ${selectedIds.size} selected schemes from the master list? This cannot be undone.`,
            confirmText: `Delete ${selectedIds.size} Schemes`,
            variant: 'danger'
        });
        if (!confirmed) return;

        setLoading(true);
        try {
            const allIds = Array.from(selectedIds);
            const chunkSize = 200;
            let totalRemoved = 0;

            for (let i = 0; i < allIds.length; i += chunkSize) {
                const chunk = allIds.slice(i, i + chunkSize);
                const res = await authFetch('/api/data', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        action: 'bulk_delete',
                        collection: 'brokerage_masters',
                        payload: chunk
                    })
                });

                if (!res.ok) {
                    const errorJson = await res.json().catch(() => ({}));
                    throw new Error(errorJson.error || `Bulk delete failed at chunk ${i / chunkSize + 1}`);
                }

                const result = await res.json();
                totalRemoved += (result.count ?? 0);
            }

            if (totalRemoved === 0) {
                showToast("Nothing was deleted. Items may have been already removed.", 'warning');
            } else {
                showToast(`Successfully removed ${totalRemoved} schemes from the Master list.`, 'success');
            }

            setSelectedIds(new Set());
            fetchData();
        } catch (err: any) {
            console.error('Bulk delete failed:', err);
            showToast(`Bulk delete failed: ${err.message}`, 'error');
        } finally {
            setLoading(false);
        }
    };

    const toggleSelectAll = () => {
        if (selectedIds.size === filteredData.length) {
            setSelectedIds(new Set());
        } else {
            setSelectedIds(new Set(filteredData.map(item => item.id)));
        }
    };

    const toggleSelectRow = (id: string) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const amcList = useMemo(() => {
        const amcs = [...new Set(data.map(item => item.amcName))].filter(Boolean).sort();
        return amcs;
    }, [data]);

    const yearsList = useMemo(() => {
        const years = new Set<string>();
        years.add(new Date().getFullYear().toString());
        data.forEach(item => {
            const y = item.period?.split('-')[0];
            if (y && y.length === 4) years.add(y);
        });
        return Array.from(years).sort().reverse();
    }, [data]);

    const filteredData = useMemo(() => {
        const matched = data.filter(item => {
            const matchesSearch =
                item.amcName?.toLowerCase().includes(search.toLowerCase()) ||
                item.schemeName?.toLowerCase().includes(search.toLowerCase());
            const matchesAmc = amcFilter === 'ALL' || item.amcName === amcFilter;

            const [y, m] = (item.period || '').split('-');
            const matchesYear = yearFilter === 'ALL' || y === yearFilter;
            const matchesMonth = monthFilter === 'ALL' || m === monthFilter;

            return matchesSearch && matchesAmc && matchesYear && matchesMonth;
        });
        if (!latestOnly) return matched;
        // Keep only the newest effective period for each AMC + scheme, so a scheme
        // that has been re-rated shows its CURRENT rate once rather than every
        // historical version side by side.
        const newest = new Map<string, typeof matched[number]>();
        for (const item of matched) {
            const key = `${String(item.amcName || '').toUpperCase().replace(/[^A-Z0-9]/g, '')}|${String(item.schemeName || '').toUpperCase().replace(/[^A-Z0-9]/g, '')}`;
            const prev = newest.get(key);
            if (!prev || String(item.period || '') > String(prev.period || '')) newest.set(key, item);
        }
        return Array.from(newest.values());
    }, [data, search, amcFilter, monthFilter, yearFilter, latestOnly]);

    // How many rows the "current rate only" view is hiding — shown as a hint so the
    // rate history is discoverable rather than invisible.
    const supersededCount = useMemo(() => {
        if (!latestOnly) return 0;
        const matched = data.filter(item => {
            const matchesSearch =
                item.amcName?.toLowerCase().includes(search.toLowerCase()) ||
                item.schemeName?.toLowerCase().includes(search.toLowerCase());
            const matchesAmc = amcFilter === 'ALL' || item.amcName === amcFilter;
            const [y, m] = (item.period || '').split('-');
            return matchesSearch && matchesAmc
                && (yearFilter === 'ALL' || y === yearFilter)
                && (monthFilter === 'ALL' || m === monthFilter);
        });
        return Math.max(0, matched.length - filteredData.length);
    }, [data, search, amcFilter, monthFilter, yearFilter, latestOnly, filteredData.length]);

    const getEffectiveRate = (grossRate: number) => {
        if (isAdmin) return grossRate;
        const netPoolPct = 100 - globalConfig.companyExpensePct;
        const userLevelPct = (currentUser.customLevels?.[currentUser.level as keyof typeof currentUser.customLevels] ?? globalConfig.levels[currentUser.level as keyof typeof globalConfig.levels]) || 0;
        return (grossRate * (netPoolPct / 100) * (userLevelPct / 100));
    };

    // if (!isAdmin) return <div className="p-10 text-center text-slate-500 font-bold uppercase tracking-widest">Unauthorized Access</div>;

    return (
        <>
        <div className="space-y-6 animate-in fade-in duration-500">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-slate-900 tracking-tight uppercase">Brokerage Structure</h1>
                    <p className="text-slate-500 text-sm mt-1 font-medium">
                        {isAdmin ? "Master control for AMC brokerage rates and PDF extraction." : `My individual sharing rates for ${currentUser.name}.`}
                    </p>
                </div>
                <div className="flex gap-2">
                    {isAdmin && selectedIds.size > 0 && (
                        <button onClick={handleBulkDelete} className="flex items-center gap-2 px-4 py-2 bg-rose-600 text-white rounded-lg text-xs font-black uppercase tracking-widest shadow-lg shadow-rose-100"><Trash2 size={14} /> Delete Selected ({selectedIds.size})</button>
                    )}
                    <button onClick={handleExport} className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg text-xs font-black uppercase tracking-widest shadow-lg shadow-emerald-50"><Download size={14} /> Export CSV</button>
                    {isAdmin && (
                        <button onClick={handleReset} className="flex items-center gap-2 px-4 py-2 bg-slate-100 text-slate-600 rounded-lg text-xs font-black uppercase tracking-widest hover:bg-slate-200 transition"><Trash2 size={14} /> Reset Master</button>
                    )}
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="lg:col-span-1 space-y-6">
                    {isAdmin && (
                        <div className="bg-white dark:bg-slate-800 p-8 border-2 border-dashed border-slate-200 rounded-xl flex flex-col items-center">
                            <Upload className="w-12 h-12 text-blue-600 mb-4 opacity-50" />
                            <h3 className="text-sm font-black uppercase tracking-widest text-slate-900 mb-1">Upload Brokerage PDF</h3>
                            <p className="text-slate-500 text-[10px] font-bold uppercase tracking-widest mb-6 text-center">Auto-extract rates from AMC PDFs</p>

                            {error && (
                                <div className="mb-4 p-3 bg-red-50 border border-red-100 rounded-lg flex items-start gap-2 max-w-xs">
                                    <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                                    <p className="text-[10px] font-bold text-red-600 leading-tight">{error}</p>
                                </div>
                            )}

                            <input type="file" multiple accept=".pdf" onChange={handleFileChange} id="pdf-upload" className="hidden" />
                            <label htmlFor="pdf-upload" className="cursor-pointer px-8 py-3 bg-blue-600 text-white rounded-xl text-xs font-black uppercase tracking-widest hover:bg-blue-700 shadow-xl shadow-blue-50 transition">
                                {files.length > 0 ? `Selected ${files.length} PDFs` : 'Select PDF Files'}
                            </label>

                            {files.length > 0 && !loading && (
                                <button onClick={handleExtract} className="mt-4 text-blue-600 text-[10px] font-black uppercase tracking-widest hover:underline flex items-center gap-1">Process Files Now</button>
                            )}

                            {loading && (
                                <div className="mt-4 flex items-center gap-2 text-blue-600 text-[10px] font-black uppercase tracking-widest animate-pulse">
                                    <Loader2 className="animate-spin" size={14} /> Extracting data... ({extractElapsed}s elapsed)
                                </div>
                            )}

                            {/* Per-file extraction summary */}
                            {fileStats.length > 0 && (
                                <div className="mt-4 w-full space-y-1">
                                    <p className="text-[9px] font-black uppercase text-slate-400 tracking-widest mb-2">Extraction Summary</p>
                                    {fileStats.map((fs: FileStat, i: number) => (
                                        <div key={i} className={`flex items-center justify-between px-3 py-2 rounded-lg text-[10px] font-bold ${fs.extractedRows > 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-600'}`}>
                                            <span className="truncate max-w-[160px]" title={fs.fileName}>
                                                {fs.extractedRows > 0 ? '✅' : fs.encrypted ? '🔒' : '⚠️'} {fs.fileName}
                                            </span>
                                            <span className="ml-2 shrink-0">{fs.extractedRows > 0 ? `${fs.extractedRows} rows` : fs.encrypted ? 'Encrypted' : 'No data'}</span>
                                        </div>
                                    ))}
                                    {/* Lines that look like schemes but produced no row. Showing them
                                        means a partial extraction is caught here, not weeks later. */}
                                    {fileStats.some((fs: FileStat) => (fs.unparsed?.length || 0) > 0) && (
                                        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-800 p-3">
                                            <p className="text-[9px] font-black uppercase text-amber-700 dark:text-amber-400 tracking-widest mb-1.5">
                                                Possibly missed — review these lines
                                            </p>
                                            {fileStats.filter((fs: FileStat) => (fs.unparsed?.length || 0) > 0).map((fs: FileStat, i: number) => (
                                                <div key={i} className="mb-2 last:mb-0">
                                                    <p className="text-[9px] font-bold text-amber-700 dark:text-amber-400 truncate" title={fs.fileName}>{fs.fileName}</p>
                                                    <ul className="mt-1 space-y-0.5 max-h-40 overflow-y-auto">
                                                        {fs.unparsed!.map((l: string, j: number) => (
                                                            <li key={j} className="text-[10px] font-mono text-slate-600 dark:text-slate-300 leading-snug break-words">• {l}</li>
                                                        ))}
                                                    </ul>
                                                </div>
                                            ))}
                                            <p className="text-[9px] text-amber-700 dark:text-amber-400 mt-1.5 leading-tight">
                                                These were not saved. Add them with “Add Scheme” if they are real schemes.
                                            </p>
                                        </div>
                                    )}
                                    {extractionWarnings.length > 0 && extractionWarnings.map((w: string, i: number) => (
                                        <p key={i} className="text-[9px] text-amber-600 font-bold px-1 leading-tight">{w}</p>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    <div className="bg-white dark:bg-slate-800 p-6 rounded-xl border border-slate-200 shadow-sm">
                        <h3 className="text-sm font-black uppercase tracking-widest text-slate-900 mb-4">Structure Analytics</h3>
                        <div className="space-y-4">
                            <div className="flex justify-between items-center p-3 bg-slate-50 rounded-lg">
                                <span className="text-[10px] font-black text-slate-500 uppercase">Total Schemes</span>
                                <span className="text-lg font-black text-slate-900">{data.length}</span>
                            </div>
                            <div className="flex justify-between items-center p-3 bg-slate-50 rounded-lg">
                                <span className="text-[10px] font-black text-slate-500 uppercase">Tracked AMCs</span>
                                <span className="text-lg font-black text-slate-900">{amcList.length}</span>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="lg:col-span-2 space-y-6">
                    {previewData.length > 0 && (
                        <div className="bg-white rounded-xl border-t-4 border-emerald-600 shadow-xl overflow-hidden">
                            <div className="p-4 border-b border-slate-200 flex justify-between items-center bg-emerald-50/50">
                                <div>
                                    <h2 className="text-sm font-black text-emerald-900 uppercase">Extracted Review</h2>
                                    <p className="text-[9px] text-emerald-600 font-bold uppercase">{previewData.length} records found in files</p>
                                    {(() => {
                                        const existingIds = new Set(data.map((d) => d.id));
                                        const dupCount = previewData.filter(row => existingIds.has(row.id)).length;
                                        return dupCount > 0 ? (
                                            <p className="text-[9px] text-amber-600 font-bold uppercase mt-0.5">⚠ {dupCount} will overwrite existing</p>
                                        ) : null;
                                    })()}
                                </div>
                                <div className="flex items-center gap-4">
                                    <select value={selectedAmc} onChange={(e) => setSelectedAmc(e.target.value)} className="px-3 py-1.5 border border-emerald-200 rounded-lg text-[11px] font-bold focus:ring-2 focus:ring-emerald-500 outline-none bg-white">
                                        <option value="">Auto-Detect AMC</option>
                                        <option value="HDFC Mutual Fund">HDFC</option>
                                        <option value="ICICI Prudential MF">ICICI</option>
                                        <option value="SBI Mutual Fund">SBI</option>
                                        <option value="Axis Mutual Fund">Axis</option>
                                        <option value="Nippon India MF">Nippon</option>
                                    </select>
                                    <div className="flex items-center gap-1">
                                        <select value={selectedMonth} onChange={(e) => setSelectedMonth(e.target.value)} className="px-2 py-1.5 border border-emerald-200 rounded-lg text-[11px] font-bold focus:ring-2 focus:ring-emerald-500 outline-none bg-white">
                                            {['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'].map(m => (
                                                <option key={m} value={m}>{new Date(2000, parseInt(m) - 1).toLocaleString('default', { month: 'short' })}</option>
                                            ))}
                                        </select>
                                        <select value={selectedYear} onChange={(e) => setSelectedYear(e.target.value)} className="px-2 py-1.5 border border-emerald-200 rounded-lg text-[11px] font-bold focus:ring-2 focus:ring-emerald-500 outline-none bg-white">
                                            {yearsList.map(y => <option key={y} value={y}>{y}</option>)}
                                        </select>
                                    </div>
                                    <button onClick={handleSaveToMaster} className="px-6 py-2 bg-emerald-600 text-white rounded-lg text-[10px] font-black uppercase tracking-widest shadow-lg shadow-emerald-50 hover:bg-emerald-700 transition">Save to Master</button>
                                </div>
                            </div>
                            <div className="max-h-[300px] overflow-auto">
                                <table className="w-full text-left">
                                    <thead className="sticky top-0 bg-white border-b text-[9px] font-black uppercase text-slate-400">
                                        <tr>
                                            <th className="px-4 py-3">Scheme</th>
                                            <th className="px-4 py-3">Category</th>
                                            <th className="px-4 py-3 text-right">Rate (%)</th>
                                            <th className="px-4 py-3 text-right">Action</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-100 dark:divide-slate-700/50">
                                        {previewData.map((row, idx) => {
                                            const rate = Number(row.trailRate || row.finalRate) || 0;
                                            const isUnusual = (row.schemeName || '').trim().length < 8 || rate <= 0 || rate > 3.5;
                                            return (
                                            <tr key={idx} className={`hover:bg-slate-50 ${isUnusual ? 'bg-amber-50/50' : ''}`}>
                                                <td className="px-4 py-3">
                                                    <div className="flex items-center gap-1">
                                                        {isUnusual && <span title="Unusual — please review" className="text-amber-500 shrink-0">⚠</span>}
                                                        <input type="text" value={row.schemeName} onChange={e => {
                                                            const n = [...previewData];
                                                            n[idx].schemeName = e.target.value;
                                                            setPreviewData(n);
                                                        }} className="w-full bg-transparent border-none font-bold text-xs p-0 focus:ring-0" />
                                                    </div>
                                                </td>
                                                <td className="px-4 py-3">
                                                    <span className="text-[10px] font-bold text-slate-500">{row.category || '—'}</span>
                                                </td>
                                                <td className="px-4 py-3 text-right">
                                                    <input type="number" step="0.001" value={row.trailRate || row.finalRate} onChange={e => {
                                                        const rate = Number(e.target.value);
                                                        setPreviewData(prev => prev.map((r, i) => i === idx ? { ...r, trailRate: rate, finalRate: rate } : r));
                                                    }} className="w-20 bg-transparent border-none text-right font-black text-blue-600 p-0 focus:ring-0" />
                                                </td>
                                                <td className="px-4 py-3 text-right">
                                                    <button onClick={() => handleDeletePreviewRow(row.id)} className="text-rose-500"><X size={14} /></button>
                                                </td>
                                            </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}

                    <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden min-h-[500px] flex flex-col">
                        <div className="p-4 border-b border-slate-200 flex flex-wrap justify-between items-center gap-4 bg-slate-50">
                            <div className="flex items-center gap-4 flex-1">
                                <div className="relative flex-1 max-w-xs">
                                    <Search className="absolute left-3 top-2.5 text-slate-400 w-4 h-4" />
                                    <input type="text" placeholder="Search Master List..." value={search} onChange={(e) => { setSearch(e.target.value); setCurrentPage(1); }} className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-lg text-[11px] font-bold focus:ring-2 focus:ring-blue-500 bg-white" />
                                </div>
                                <select value={amcFilter} onChange={(e) => { setAmcFilter(e.target.value); setCurrentPage(1); }} className="px-4 py-2 border border-slate-200 rounded-lg text-[11px] font-bold focus:ring-2 focus:ring-blue-500 bg-white min-w-[150px]">
                                    <option value="ALL">All AMCs</option>
                                    {amcList.map(amc => <option key={amc} value={amc}>{amc}</option>)}
                                </select>
                                <div className="flex items-center gap-1">
                                    <select value={monthFilter} onChange={(e) => { setMonthFilter(e.target.value); setCurrentPage(1); }} className="px-3 py-2 border border-slate-200 rounded-lg text-[11px] font-bold focus:ring-2 focus:ring-blue-500 bg-white">
                                        <option value="ALL">Months</option>
                                        {['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'].map(m => (
                                            <option key={m} value={m}>{new Date(2000, parseInt(m) - 1).toLocaleString('default', { month: 'short' })}</option>
                                        ))}
                                    </select>
                                    <select value={yearFilter} onChange={(e) => { setYearFilter(e.target.value); setCurrentPage(1); }} className="px-3 py-2 border border-slate-200 rounded-lg text-[11px] font-bold focus:ring-2 focus:ring-blue-500 bg-white">
                                        <option value="ALL">Years</option>
                                        {yearsList.map(y => <option key={y} value={y}>{y}</option>)}
                                    </select>
                                </div>
                                {/* One row per scheme (its current rate) vs the full rate history. */}
                                <div className="flex items-center gap-2">
                                    <label className="flex items-center gap-1.5 cursor-pointer select-none" title="AMCs revise their structures. Off = show every historical version of each scheme.">
                                        <input
                                            type="checkbox"
                                            checked={latestOnly}
                                            onChange={(e) => { setLatestOnly(e.target.checked); setCurrentPage(1); }}
                                            className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                                        />
                                        <span className="text-[11px] font-bold text-slate-600 dark:text-slate-300 whitespace-nowrap">Current rate only</span>
                                    </label>
                                    {supersededCount > 0 && (
                                        <span className="text-[10px] font-bold text-slate-400 whitespace-nowrap">({supersededCount} older version{supersededCount === 1 ? '' : 's'} hidden)</span>
                                    )}
                                </div>
                            </div>
                            <div className="text-[10px] text-slate-400 font-black uppercase tracking-widest">
                                {filteredData.length} Master Schemes
                            </div>
                        </div>

                        <div className="overflow-auto flex-1">
                            <table className="w-full text-left">
                                <thead className="sticky top-0 bg-white z-10 border-b text-[9px] font-black uppercase text-slate-400 tracking-widest">
                                    <tr>
                                        {isAdmin && (
                                            <th className="px-6 py-4">
                                                <input type="checkbox" checked={filteredData.length > 0 && selectedIds.size === filteredData.length} onChange={toggleSelectAll} className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
                                            </th>
                                        )}
                                        <th className="px-6 py-4">AMC & Scheme Name</th>
                                        <th className="px-6 py-4">Period</th>
                                        <th className="px-6 py-4 text-center">{isAdmin ? 'Gross Rate' : 'My Sharing Rate'}</th>
                                        {isAdmin && <th className="px-6 py-4 text-right">Control</th>}
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100 dark:divide-slate-700/50">
                                    {filteredData.slice((currentPage - 1) * pageSize, currentPage * pageSize).map((row) => (
                                        <tr key={row.id} className={`hover:bg-slate-50 transition ${selectedIds.has(row.id) ? 'bg-blue-50/50' : ''}`}>
                                            {isAdmin && (
                                                <td className="px-6 py-4">
                                                    <input type="checkbox" checked={selectedIds.has(row.id)} onChange={() => toggleSelectRow(row.id)} className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
                                                </td>
                                            )}
                                            <td className="px-6 py-4">
                                                <div className="flex flex-col">
                                                    {editingId === row.id ? (
                                                        <input type="text" value={editValues.schemeName} onChange={e => setEditValues({ ...editValues, schemeName: e.target.value.toUpperCase() })} className="w-full border-blue-500 border rounded px-2 py-1 text-xs font-bold focus:ring-2 focus:ring-blue-100 outline-none" autoFocus />
                                                    ) : (
                                                        <span className="text-slate-900 font-black text-xs">{row.schemeName}</span>
                                                    )}
                                                    <span className="text-blue-600 text-[10px] font-black uppercase tracking-widest mt-0.5">{row.amcName}</span>
                                                </div>
                                            </td>
                                            <td className="px-6 py-4">
                                                <span className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">{row.period || 'N/A'}</span>
                                            </td>
                                            <td className="px-6 py-4 text-center">
                                                {editingId === row.id ? (
                                                    <input type="number" step="0.001" value={editValues.trailRate} onChange={e => setEditValues({ ...editValues, trailRate: e.target.value })} className="w-20 border-blue-500 border rounded px-2 py-1 text-xs font-bold text-center" />
                                                ) : (
                                                    <span className={`font-black ${isAdmin ? 'text-slate-900' : 'text-emerald-700'} text-base`}>
                                                        {parseFloat(getEffectiveRate(Number(row.trailRate) || 0).toFixed(4))}%
                                                    </span>
                                                )}
                                            </td>
                                            {isAdmin && (
                                                <td className="px-6 py-4 text-right">
                                                    <div className="flex justify-end gap-1">
                                                        {editingId === row.id ? (
                                                            <>
                                                                <button onClick={() => handleSaveEdit(row.id)} className="p-2 text-emerald-600 hover:bg-emerald-50 rounded-lg"><Save size={14} /></button>
                                                                <button onClick={cancelEditing} className="p-2 text-slate-400 hover:bg-slate-100 rounded-lg"><X size={14} /></button>
                                                            </>
                                                        ) : (
                                                            <>
                                                                <button onClick={() => fetchHistory(row)} className="p-2 text-slate-400 hover:text-violet-600" title="Rate History"><RefreshCw size={14} /></button>
                                                                <button onClick={() => startEditing(row)} className="p-2 text-slate-400 hover:text-blue-600"><Edit size={14} /></button>
                                                                <button onClick={() => handleDeleteRow(row.id)} className="p-2 text-slate-400 hover:text-red-600"><Trash2 size={14} /></button>
                                                            </>
                                                        )}
                                                    </div>
                                                </td>
                                            )}
                                        </tr>
                                    ))}
                                    {filteredData.length === 0 && (
                                        <tr><td colSpan={4} className="py-20 text-center text-slate-400 uppercase text-[10px] font-black tracking-widest">No matching records</td></tr>
                                    )}
                                </tbody>
                            </table>
                            <Pagination
                                currentPage={currentPage}
                                totalItems={filteredData.length}
                                pageSize={pageSize}
                                onPageChange={setCurrentPage}
                            />
                        </div>
                    </div>
                </div>
            </div>
        </div>

        {/* Rate History Modal */}
        {historyModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
                <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-lg mx-4 flex flex-col max-h-[80vh]">
                    <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-700">
                        <div>
                            <h3 className="font-bold text-slate-900 dark:text-slate-100 text-sm">Rate History</h3>
                            <p className="text-xs text-slate-400 dark:text-slate-500 truncate mt-0.5 max-w-xs">{historyModal.schemeName}</p>
                        </div>
                        <button onClick={() => setHistoryModal(null)} className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition">
                            <X size={16} />
                        </button>
                    </div>
                    <div className="flex-1 overflow-y-auto p-4">
                        {historyLoading ? (
                            <div className="flex items-center justify-center py-12">
                                <Loader2 className="animate-spin text-blue-500 w-6 h-6" />
                            </div>
                        ) : historyModal.rows.length === 0 ? (
                            <div className="text-center py-12 text-slate-400 text-sm">No rate changes recorded yet.</div>
                        ) : (
                            <div className="space-y-3">
                                {historyModal.rows.map((h: any, idx: number) => (
                                    <div key={idx} className="flex items-start gap-3 p-3 rounded-xl bg-slate-50 dark:bg-slate-900/50">
                                        <div className="w-2 h-2 rounded-full bg-violet-400 shrink-0 mt-1.5" />
                                        <div className="flex-1 min-w-0">
                                            <p className="text-xs text-slate-700 dark:text-slate-300">
                                                <span className="font-bold">{h.changedByName || 'System'}</span> changed rate from{' '}
                                                <span className="font-black text-red-500">{Number(h.oldRate).toFixed(4)}%</span> to{' '}
                                                <span className="font-black text-emerald-600">{Number(h.newRate).toFixed(4)}%</span>
                                            </p>
                                            <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">
                                                {new Date(h.changedAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                            </p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        )}
        </>
    );
};
