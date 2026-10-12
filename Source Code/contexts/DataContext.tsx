
import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { Client, TeamMember, BrokerageTransaction, SharingConfig, ImportBatch, MappingEntry, PayoutInvoice } from '../types';
import { MOCK_TEAM, GLOBAL_CONFIG, MOCK_CLIENTS, MOCK_TRANSACTIONS, MOCK_BATCHES } from '../services/mockData';
import { runBatchCalculation } from '../services/calculationService';
import { useToast } from '../components/Toast';

export interface ServerSummary {
  totalTx: number;
  totalGross: number;
  myTotal: number;
  clientCount: number;
  monthly: Array<{ month: string; gross: number; cnt: number }>;
}

interface DataContextType {
  clients: Client[];
  updateClients: (clients: Client[]) => void;
  upsertClients: (newClients: Client[]) => Promise<boolean>;
  deleteClient: (clientId: string) => void;
  team: TeamMember[];
  updateTeam: (team: TeamMember[]) => Promise<boolean>;
  upsertTeamMember: (member: TeamMember) => Promise<boolean>;
  deleteTeamMember: (memberId: string) => void;
  transactions: BrokerageTransaction[];
  addTransactions: (txs: BrokerageTransaction[]) => Promise<boolean>;
  batches: ImportBatch[];
  addBatch: (batch: ImportBatch) => Promise<boolean>;
  deleteBatch: (batchId: string) => Promise<void>;
  restoreBatch: (batchId: string) => Promise<void>;
  purgeBatch: (batchId: string) => Promise<void>;
  globalConfig: SharingConfig;
  updateConfig: (config: SharingConfig) => void;
  amcMappings: MappingEntry[];
  schemeMappings: MappingEntry[];
  updateAmcMappings: (mappings: MappingEntry[]) => void;
  updateSchemeMappings: (mappings: MappingEntry[]) => void;
  invoices: PayoutInvoice[];
  addInvoice: (invoice: PayoutInvoice) => Promise<boolean>;
  updateInvoice: (invoice: PayoutInvoice) => void;
  recalculateAllTransactions: () => Promise<boolean>;
  refreshDashboard: () => void;
  clearAllData: () => void;
  loading: boolean;
  isOnline: boolean;
  isSyncing: boolean;
  serverSummary: ServerSummary | null;
  refreshTick: number;
}

const DataContext = createContext<DataContextType | undefined>(undefined);

// Helper: authenticated fetch with JWT
export const authFetch = async (url: string, options: RequestInit = {}): Promise<Response> => {
  const token = localStorage.getItem('wf_token');
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> || {}),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (options.body && typeof options.body === 'string') {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(url, { ...options, headers });

  // CRITICAL: Only reload if a token was present (session expired).
  // If NO token was present, we are likely on the login page or initial load.
  if (response.status === 401 && token) {
    localStorage.removeItem('wf_token');
    localStorage.removeItem('wf_user');
    window.location.reload();
  }
  return response;
};

export const DataProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { showToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [isOnline, setIsOnline] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);

  const [clients, setClients] = useState<Client[]>([]);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [globalConfig, setGlobalConfig] = useState<SharingConfig>(GLOBAL_CONFIG);
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [transactions, setTransactions] = useState<BrokerageTransaction[]>([]);
  const [amcMappings, setAmcMappings] = useState<MappingEntry[]>([]);
  const [schemeMappings, setSchemeMappings] = useState<MappingEntry[]>([]);
  const [invoices, setInvoices] = useState<PayoutInvoice[]>([]);
  const [serverSummary, setServerSummary] = useState<ServerSummary | null>(null);
  // Bumped every time data is (re)fetched — server-computed views (e.g. Reports
  // Team Payouts) depend on this so they refresh after a recalculation instead of
  // showing the pre-change numbers.
  const [refreshTick, setRefreshTick] = useState(0);

  const fetchData = useCallback(async () => {
    const token = localStorage.getItem('wf_token');

    // If no token, we can't fetch protected data. 
    // BUT we need the team list for the login screen's local check.
    if (!token) {
      setTeam(MOCK_TEAM);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const json = (r: Response) => { if (!r.ok) throw new Error(r.statusText); return r.json(); };

      // Phase 1: fetch team + config + summary first — these unblock the UI immediately
      const [teamRes, configRes, summaryRes] = await Promise.allSettled([
        authFetch('/api/data?type=team').then(json),
        authFetch('/api/data?type=config').then(json),
        authFetch('/api/data?action=summary').then(json),
      ]);

      if (teamRes.status === 'rejected') throw new Error("API unreachable");

      const fetchedTeam = teamRes.status === 'fulfilled' ? teamRes.value : [];
      if (fetchedTeam.length === 0) {
        console.log("⚠️ [Data] Team empty. Seeding with default credentials.");
        setTeam(MOCK_TEAM);
        if (teamRes.status === 'fulfilled') saveToDb('team', MOCK_TEAM, 'id');
      } else {
        setTeam(fetchedTeam);
      }

      const configVal = configRes.status === 'fulfilled' ? configRes.value : [];
      setGlobalConfig(Array.isArray(configVal) && configVal.length > 0 ? configVal[0] : GLOBAL_CONFIG);

      if (summaryRes.status === 'fulfilled') setServerSummary(summaryRes.value);

      setIsOnline(true);
      setLoading(false); // ← unblock UI as soon as team+config are ready

      // Phase 2: fetch remaining data in background (doesn't block the screen)
      const [clientsRes, batchesRes, txRes, amcRes, schemeRes, invoicesRes] = await Promise.allSettled([
        authFetch('/api/data?type=clients').then(json),
        authFetch('/api/data?type=batches').then(json),
        authFetch('/api/data?type=transactions').then(json),
        authFetch('/api/data?type=amc_mappings').then(json),
        authFetch('/api/data?type=scheme_mappings').then(json),
        authFetch('/api/data?type=invoices').then(json),
      ]);

      const get = <T,>(r: PromiseSettledResult<T>, d: T): T => r.status === 'fulfilled' ? r.value : d;
      setClients(get(clientsRes, []));
      setBatches(get(batchesRes, []));
      setTransactions(get(txRes, []));
      setAmcMappings(get(amcRes, []));
      setSchemeMappings(get(schemeRes, []));
      setInvoices(get(invoicesRes, []));
      setRefreshTick(t => t + 1); // signal dependents (reports) to re-fetch server views

    } catch (err) {
      console.warn("Backend API unavailable. Switching to Offline Mode.", err);
      setIsOnline(false);
      setTeam(MOCK_TEAM);
      setClients(MOCK_CLIENTS);
      setTransactions(MOCK_TRANSACTIONS);
      setBatches(MOCK_BATCHES);
      setGlobalConfig(GLOBAL_CONFIG);
      setAmcMappings([]);
      setSchemeMappings([]);
      setInvoices([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Returns true only when the change was confirmed saved by the server.
  // On offline / failure it surfaces an error toast so a failed write can
  // NEVER look like a success. Callers that show their own success message
  // should await this and branch on the result.
  const saveToDb = async (collection: string, payload: any, upsertField?: string): Promise<boolean> => {
    if (!isOnline) {
      showToast('You are working offline — your change was NOT saved.', 'error');
      return false;
    }

    setIsSyncing(true);
    try {
      const post = async (reqBody: any): Promise<any> => {
        const r = await authFetch('/api/data', { method: 'POST', body: JSON.stringify(reqBody) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        try { return await r.clone().json(); } catch { return {}; }
      };
      // Adopt the server-stamped version on the records we just saved, so the
      // NEXT edit sends a current base version instead of the now-stale one.
      const list: any[] = Array.isArray(payload) ? payload : [payload];
      const adopt = (stamp?: string) => {
        if (!stamp) return;
        for (const it of list) if (it && typeof it === 'object') it.updatedAt = stamp;
      };

      let body = await post({ collection, payload, upsertField });
      adopt(body?.stamped);

      // ── An earlier import of this same file was replaced ──────────────────
      // Re-uploading a month used to leave BOTH copies in place, so the month
      // read roughly double. The server now sends the superseded import to Trash
      // and takes its rows out of every figure. Say so out loud: the whole reason
      // the doubling went unnoticed is that nothing ever mentioned it.
      const gone = Array.isArray(body?.superseded) ? body.superseded : [];
      if (gone.length) {
        const rows = gone.reduce((s: number, g: any) => s + (Number(g?.rows) || 0), 0);
        const ids = new Set(gone.map((g: any) => g?.id));
        const stamp = new Date().toISOString();
        setBatches(prev => prev.map(b => ids.has(b.id) ? { ...b, deletedAt: stamp } : b));
        showToast(
          `This file was already imported. The earlier import was moved to Trash and its ${rows.toLocaleString('en-IN')} row${rows === 1 ? '' : 's'} removed, so this month is counted once.`,
          'success'
        );
      }

      // ── A promotion moved clients on the server ───────────────────────────
      // The server places the promoted person's clients at their new level by itself
      // (from the chosen month). Say what it did, name any it had to leave alone, and
      // reload the clients: this tab still holds the old placements, and saving one
      // of them again would otherwise write the old chain back.
      const lm: any[] = Array.isArray(body?.levelMove) ? body.levelMove : [];
      if (lm.length) {
        const done = lm.filter(m => m && !m.error);
        const left = done.reduce((n, m) => n + (Number(m.blocked) || 0), 0);
        const parts = done.map(m => `Level ${m.from} to ${m.to}: ${(Number(m.moved) || 0) + (Number(m.replaced) || 0)} client${((Number(m.moved) || 0) + (Number(m.replaced) || 0)) === 1 ? '' : 's'} moved`);
        const failed = lm.some(m => m && m.error);
        showToast(
          (parts.length ? parts.join('; ') + '. ' : '') +
          (left ? `${left} client${left === 1 ? ' was' : 's were'} left alone because that level is already held by someone else on them. ` : '') +
          (failed ? 'Some clients could not be moved; check the Audit Log. ' : '') +
          'Payouts are being recalculated.',
          left || failed ? 'warning' : 'success'
        );
        authFetch(`/api/data?type=clients&_=${Date.now()}`, { cache: 'no-store' })
          .then(r => r.ok ? r.json() : Promise.reject()).then(setClients).catch(() => {});
      }

      // ── Stale base version → rebase and retry ONCE ───────────────────────
      // The server refuses a write whose base version is older than what it
      // holds. For an EXPLICIT single-record edit — the user typed these values
      // and pressed Save — that is almost always this tab's own copy having
      // aged (e.g. saving the same RM profile twice in a row: the first save
      // advances the version, so the form's base is instantly stale). That was
      // being reported as success while the write was silently dropped, which
      // is why an edit "had to be repeated 2-3 times". Re-read the current
      // version, rebase this record on it and retry so the edit lands on the
      // FIRST click.
      // Bulk payloads are deliberately NOT auto-retried: re-pushing a stale
      // snapshot of many records is precisely the mass-revert this guard exists
      // to prevent.
      const isSingleGuarded = list.length === 1 && (collection === 'clients' || collection === 'team');
      if (body?.conflictCount > 0 && isSingleGuarded) {
        try {
          // MUST bypass the browser cache. This endpoint is served with
          // `Cache-Control: private, max-age=300`, so a plain re-fetch hands back
          // the SAME stale snapshot we just conflicted against — the retry then
          // fails identically and the user is told to re-apply a change that can
          // never land ("This record was changed elsewhere..." on every attempt).
          const fresh = await authFetch(`/api/data?type=${collection}&_=${Date.now()}`, { cache: "no-store" }).then(r => r.ok ? r.json() : Promise.reject());
          if (Array.isArray(fresh)) {
            if (collection === 'clients') setClients(fresh); else setTeam(fresh);
            const current = fresh.find((x: any) => x && x.id === list[0]?.id);
            if (current?.updatedAt) {
              list[0].updatedAt = current.updatedAt;      // rebase onto the live version
              body = await post({ collection, payload, upsertField });
              adopt(body?.stamped);
            }
          }
        } catch { /* fall through to the failure path below */ }
      }

      if (body?.conflictCount > 0) {
        // Never return success for a write the server skipped — reporting
        // "Saved" for a dropped write is what made this class of bug invisible.
        showToast('This record was changed elsewhere, so your edit was NOT saved. The latest data has been reloaded — please re-apply your change.', 'error');
        const json = (r: Response) => r.ok ? r.json() : Promise.reject();
        if (collection === 'clients') authFetch('/api/data?type=clients').then(json).then(setClients).catch(() => {});
        if (collection === 'team') authFetch('/api/data?type=team').then(json).then(setTeam).catch(() => {});
        setRefreshTick(t => t + 1);
        return false;
      }
      return true;
    } catch (e) {
      console.error(`Failed to save ${collection}`, e);
      showToast(`Could not save changes to ${collection}. Check your connection and try again — nothing was saved.`, 'error');
      return false;
    } finally {
      setIsSyncing(false);
    }
  };

  const deleteFromDb = async (collection: string, id: string): Promise<boolean> => {
    if (!isOnline) {
      showToast('You are working offline — the delete was NOT saved.', 'error');
      return false;
    }

    setIsSyncing(true);
    try {
      const response = await authFetch(`/api/data?type=${collection}&id=${id}`, {
        method: 'DELETE'
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return true;
    } catch (e) {
      console.error(`Failed to delete from ${collection}`, e);
      showToast(`Could not delete from ${collection}. Check your connection and try again.`, 'error');
      return false;
    } finally {
      setIsSyncing(false);
    }
  };

  // Callers pass the WHOLE clients array with one/few records modified
  // (e.g. `updateClients(clients.map(c => c.id === x ? {...c, ...} : c))`).
  // We must persist ONLY the records that actually changed: POSTing the whole
  // array pushes this tab's (possibly stale) copy of every client back to the
  // server, silently reverting anything changed elsewhere since the tab loaded.
  // Editing one client was re-uploading ~1,400 records and wiping server-side
  // RM re-mappings. Same rule as upsertClients / upsertTeamMember.
  const updateClients = (newClients: Client[]): Promise<boolean> => {
    const prevById = new Map(clients.map(c => [c.id, c]));
    const changed = newClients.filter(c => {
      const prev = prevById.get(c.id);
      return !prev || JSON.stringify(prev) !== JSON.stringify(c);
    });
    // NOTE: deliberately does NOT stamp a new timestamp. The record keeps the
    // `updatedAt` it was LOADED with — that is the base version the server checks
    // against. Stamping the browser's clock here made every save from a machine
    // whose clock trailed the server look stale, so it was rejected until real
    // time caught up ("had to save 2-3 times"). The server stamps the new value.
    setClients(newClients);
    if (changed.length === 0) return Promise.resolve(true);
    return saveToDb('clients', changed, 'id');
  };

  // Returns the persistence promise so callers (e.g. the import flow) can AWAIT
  // the clients being saved on the server before doing follow-up work such as
  // re-mapping orphan transactions to the newly-created clients.
  const upsertClients = (newClients: Client[]): Promise<boolean> => {
    const prev = clients;
    const existingPans = new Set(prev.map(c => c.pan.toUpperCase()));
    const filteredNew = newClients.filter(c => !existingPans.has(c.pan.toUpperCase()));

    // Track ONLY the records this call actually changes. Critical: we must never
    // POST the whole clients array — that would push this browser tab's (possibly
    // stale) copy of EVERY client back to the server, silently reverting any
    // change made elsewhere since the tab loaded (e.g. an RM re-mapping done by
    // another user or a server-side script). An import previously wiped ~1,400
    // clients' hierarchy this way. Same lesson as updateTeam → upsertTeamMember.
    const changed: Client[] = [];
    const updated = prev.map(existing => {
      const match = newClients.find(n => n.pan.toUpperCase() === existing.pan.toUpperCase());
      if (match) {
        const combinedFolios = Array.from(new Set([...existing.folios, ...match.folios]));
        if (combinedFolios.length !== existing.folios.length) {
          const merged = { ...existing, folios: combinedFolios };
          changed.push(merged);
          return merged;
        }
      }
      return existing;
    });

    setClients([...updated, ...filteredNew]);
    const toSave = [...changed, ...filteredNew];
    if (toSave.length === 0) return Promise.resolve(true);
    return saveToDb('clients', toSave, 'id');
  };

  const deleteClient = (clientId: string) => {
    setClients(prev => prev.filter(c => c.id !== clientId));
    deleteFromDb('clients', clientId);
  };

  const updateTeam = async (newTeam: TeamMember[]): Promise<boolean> => {
    setTeam(newTeam);
    return saveToDb('team', newTeam, 'id');
  };

  // Single-record save: persists ONE member without rewriting the whole team
  // table. Critical — the bulk updateTeam() POSTs all 184 rows, so saving one
  // edit from a slightly-stale browser tab would overwrite (revert) everyone
  // else's rates. Editing one user must only touch that user's row.
  const upsertTeamMember = async (member: TeamMember): Promise<boolean> => {
    // Keep the loaded `updatedAt` as the base version — never re-stamp it here
    // (see updateClients: client clocks must not drive the concurrency check).
    setTeam(prev => prev.some(m => m.id === member.id)
      ? prev.map(m => m.id === member.id ? member : m)
      : [...prev, member]);
    return saveToDb('team', [member], 'id');
  };

  const deleteTeamMember = (memberId: string) => {
    setTeam(prev => prev.filter(t => t.id !== memberId));
    deleteFromDb('team', memberId);
  };

  const addTransactions = async (newTxs: BrokerageTransaction[]): Promise<boolean> => {
    // Drop any copy already held under an incoming id before appending. Transaction
    // ids are content hashes and the server upserts on them, so re-importing a
    // statement leaves ONE row in the database — but appending regardless showed
    // the month twice on screen until the next refresh, which is exactly the shape
    // of "my brokerage doubled" that nobody should have to talk themselves out of.
    // Keyed on a Set so this stays cheap against a 200k-row array.
    const incoming = new Set(newTxs.map(t => t.id));
    setTransactions(prev => [...prev.filter(t => !incoming.has(t.id)), ...newTxs]);
    return saveToDb('transactions', newTxs);
  };

  const addBatch = async (batch: ImportBatch): Promise<boolean> => {
    // Replace any batch already held under this id rather than prepending blindly.
    // The server upserts on the primary key, so recording the same batch twice —
    // Finalize pressed again on a preview that is still open, or a retry after a
    // partial save — leaves ONE row there. Prepending regardless put two identical
    // lines in Batch History, which reads as duplicated data and sent an operator
    // looking for a double import that had never happened.
    setBatches(prev => [batch, ...prev.filter(b => b.id !== batch.id)]);
    return saveToDb('batches', batch);
  };

  // Soft-delete: marks batch with deletedAt locally and on server.
  // Transactions consumed via `useData().transactions` are filtered by active batches downstream.
  const deleteBatch = async (batchId: string) => {
    const stamp = new Date().toISOString();
    setBatches(prev => prev.map(b => b.id === batchId ? { ...b, deletedAt: stamp } : b));

    setIsSyncing(true);
    try {
      const response = await authFetch(`/api/data?action=undo_import&id=${batchId}`, {
        method: 'DELETE'
      });
      if (!response.ok) throw new Error('Delete API request failed');
    } catch (e) {
      console.error(`Failed to delete batch`, e);
      // Rollback optimistic update on failure
      setBatches(prev => prev.map(b => b.id === batchId ? { ...b, deletedAt: undefined } : b));
    } finally {
      setIsSyncing(false);
    }
  };

  const restoreBatch = async (batchId: string) => {
    setBatches(prev => prev.map(b => b.id === batchId ? { ...b, deletedAt: undefined, deletedBy: undefined } : b));
    setIsSyncing(true);
    try {
      const response = await authFetch(`/api/data?action=restore_batch&id=${batchId}`, {
        method: 'DELETE'
      });
      if (!response.ok) throw new Error('Restore API request failed');
    } catch (e) {
      console.error('Failed to restore batch', e);
    } finally {
      setIsSyncing(false);
    }
  };

  const purgeBatch = async (batchId: string) => {
    setBatches(prev => prev.filter(b => b.id !== batchId));
    setTransactions(prev => prev.filter(t => t.batchId !== batchId));
    setIsSyncing(true);
    try {
      const response = await authFetch(`/api/data?action=purge_batch&id=${batchId}`, {
        method: 'DELETE'
      });
      if (!response.ok) throw new Error('Purge API request failed');
    } catch (e) {
      console.error('Failed to purge batch', e);
    } finally {
      setIsSyncing(false);
    }
  };

  const updateConfig = (newConfig: SharingConfig) => {
    setGlobalConfig(newConfig);
    saveToDb('config', newConfig, 'id');
    // Deliberately does NOT recalculate here. This used to run the whole payout
    // engine over every loaded transaction IN THE BROWSER and POST them all back
    // in a single body — which (a) blew past the 50mb request limit once the book
    // grew, (b) only ever saw the truncated slice this tab had loaded, so
    // transactions outside it kept stale breakdowns, (c) ignored lockedPeriods and
    // silently restated settled months, and (d) ran even when the operator answered
    // "No" to the Recalculate prompt. Recalculation is a SERVER job: callers ask
    // the user, then invoke recalculateAllTransactions(), which recomputes every
    // row from current config and rebuilds payout_ledger atomically.
  };

  const updateAmcMappings = (mappings: MappingEntry[]) => {
    setAmcMappings(mappings);
    saveToDb('amc_mappings', mappings, 'original');
  };

  const updateSchemeMappings = (mappings: MappingEntry[]) => {
    setSchemeMappings(mappings);
    saveToDb('scheme_mappings', mappings, 'original');
  };

  // Persist FIRST, then update local state only on success — otherwise the row
  // shows "SUBMITTED" (and a green success toast) even when the server rejected
  // the save (e.g. an RM hitting the write gate), which is exactly the
  // "raised successfully" + "nothing was saved" contradiction. Returns the
  // outcome so the caller can gate its own success toast.
  const addInvoice = (invoice: PayoutInvoice): Promise<boolean> => {
    return saveToDb('invoices', invoice, 'id').then(ok => {
      // Upsert, don't blindly prepend — re-raising or MODIFYING an invoice reuses
      // the same id, so a plain prepend would show the same invoice twice.
      if (ok) setInvoices(prev => prev.some(i => i.id === invoice.id)
        ? prev.map(i => i.id === invoice.id ? invoice : i)
        : [invoice, ...prev]);
      return ok;
    });
  };

  const updateInvoice = (updatedInvoice: PayoutInvoice) => {
    setInvoices(prev => prev.map(inv => inv.id === updatedInvoice.id ? updatedInvoice : inv));
    saveToDb('invoices', updatedInvoice, 'id');
  };

  const recalculateAllTransactions = async (): Promise<boolean> => {
    // Server-side recompute: reliably recomputes EVERY transaction's breakdown +
    // payout_ledger from the CURRENT mappings/config. We POLL recalc_status until
    // the background job actually finishes, then refresh — so the screen reflects
    // the NEW numbers when it's truly done (instead of a blind fixed wait that
    // could refresh too early and show stale amounts).
    if (!isOnline) {
      showToast('You are offline — cannot recalculate.', 'error');
      return false;
    }
    try {
      const r = await authFetch('/api/data?action=recalc_all');
      if (!r.ok) {
        showToast('Could not start recalculation (you may not have permission).', 'error');
        return false;
      }
      const startedAt = Date.now();
      const MAX_MS = 6 * 60 * 1000;       // hard cap so we never poll forever
      const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));
      while (Date.now() - startedAt < MAX_MS) {
        await sleep(3000);
        try {
          const sres = await authFetch('/api/data?action=recalc_status');
          if (!sres.ok) continue;
          const st = await sres.json();
          if (st && st.running === false && (st.finishedAt || st.error)) {
            if (st.error) { showToast('Recalculation failed: ' + st.error, 'error'); return false; }
            await fetchData();
            return true;
          }
        } catch { /* transient — keep polling */ }
      }
      // Timed out waiting; refresh anyway so the user sees the latest state.
      await fetchData();
      return true;
    } catch (e) {
      console.warn('Server recalc failed', e);
      showToast('Recalculation could not complete. Please try again.', 'error');
      return false;
    }
  };

  const refreshDashboard = () => fetchData();

  const clearAllData = () => {
    setLoading(true);
    if (isOnline) {
      authFetch('/api/data?action=reset', { method: 'DELETE' })
        .then(() => window.location.reload())
        .catch(() => window.location.reload());
    } else {
      window.location.reload();
    }
  };

  // Hide transactions whose batch is soft-deleted so dashboards/reports stay accurate
  // while the batch sits in the trash. Consumers wanting all batches still get them via `batches`.
  const deletedBatchIds = new Set(batches.filter(b => b.deletedAt).map(b => b.id));
  const activeTransactions = deletedBatchIds.size === 0
    ? transactions
    : transactions.filter(t => !deletedBatchIds.has(t.batchId));

  return (
    <DataContext.Provider value={{
      clients,
      updateClients,
      upsertClients,
      deleteClient,
      team,
      updateTeam,
      upsertTeamMember,
      deleteTeamMember,
      transactions: activeTransactions,
      addTransactions,
      batches,
      addBatch,
      deleteBatch,
      restoreBatch,
      purgeBatch,
      globalConfig,
      updateConfig,
      amcMappings,
      schemeMappings,
      updateAmcMappings,
      updateSchemeMappings,
      invoices,
      addInvoice,
      updateInvoice,
      recalculateAllTransactions,
      refreshDashboard,
      clearAllData,
      loading,
      isOnline,
      isSyncing,
      serverSummary,
      refreshTick
    }}>
      {children}
    </DataContext.Provider>
  );
};

export const useData = () => {
  const context = useContext(DataContext);
  if (context === undefined) {
    throw new Error('useData must be used within a DataProvider');
  }
  return context;
};
