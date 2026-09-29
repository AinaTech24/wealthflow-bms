
import React, { useState, useMemo } from 'react';
import { Users, Search, Plus, Edit2, X, UserCheck, Shield, ChevronRight, Tags, Database, Save, Key, Copy, Check, Mail, Trash2, UserPlus, GitMerge, Phone, AlertCircle, Download } from 'lucide-react';
import { Client, TeamMember, Role } from '../types';
import { useData, authFetch } from '../contexts/DataContext';
import { Pagination } from '../components/Pagination';
import { useToast } from '../components/Toast';
import { formatCompactINR } from '../utils/formatINR';
import { exportToExcel } from '../utils/excelExport';
import { useClientAum } from '../utils/clientAum';

interface ClientsAndHierarchyProps {
  currentUser: TeamMember;
}

export const ClientsAndHierarchy: React.FC<ClientsAndHierarchyProps> = ({ currentUser }) => {
  const { clients, updateClients, deleteClient, team, upsertTeamMember, deleteTeamMember, globalConfig, amcMappings, schemeMappings, updateAmcMappings, updateSchemeMappings, recalculateAllTransactions, transactions } = useData();
  const { showToast, showConfirm } = useToast();

  const isAdmin = currentUser.role === Role.ADMIN;
  const [activeTab, setActiveTab] = useState<'hierarchy' | 'clients' | 'standardize'>(isAdmin ? 'hierarchy' : 'clients');

  const [isTeamModalOpen, setIsTeamModalOpen] = useState(false);
  const [isClientModalOpen, setIsClientModalOpen] = useState(false);
  const [editingMember, setEditingMember] = useState<TeamMember | null>(null);
  const [editingClient, setEditingClient] = useState<Client | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Effective-dating controls. A level/rate change applies from the chosen month
  // FORWARD, so a promotion never restates months already reported or invoiced.
  // Offer the last 18 months plus "all months" for a genuine correction.
  const thisMonth = new Date().toISOString().slice(0, 7);
  const effectiveMonthOptions = React.useMemo(() => {
    const out: Array<{ value: string; label: string }> = [];
    const d = new Date();
    for (let i = 0; i < 18; i++) {
      const y = d.getFullYear(), m = d.getMonth();
      const dt = new Date(y, m - i, 1);
      const value = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
      out.push({ value, label: dt.toLocaleString("en-IN", { month: "long", year: "numeric" }) });
    }
    return out;
  }, []);

  const [memberForm, setMemberForm] = useState<Partial<TeamMember & { sharingRate: string }>>({
    name: '', code: '', role: Role.OPS, level: 1, email: '', password: '', parentId: '', sharingRate: '0',
    gstNumber: '',
    bankDetails: { accountName: '', accountNumber: '', bankName: '', ifscCode: '', branch: '' },
    address: { street: '', city: '', state: '', pincode: '', country: 'India' }
  });

  const [clientForm, setClientForm] = useState<Partial<Client>>({
    name: '', pan: '', folios: [], email: '', mobile: ''
  });
  // The folio box has to hold RAW TEXT while it is being typed. Rendering it as
  // folios.join(', ') and parsing on every keystroke made the comma impossible
  // to type: the moment you pressed "," the value ended in an empty segment,
  // .filter(Boolean) dropped it, and the re-render handed back a string with no
  // comma at all. Two folios silently fused into one 22-digit number
  // ("11366282/49" + "45966856/64" -> "11366282/4945966856/64"), which then
  // matched no transaction. Same reason a space after the comma never survived.
  const [folioText, setFolioText] = useState('');
  const parseFolios = (text: string) =>
    [...new Set(text.split(',').map(f => f.trim()).filter(Boolean))];

  const [isMappingModalOpen, setIsMappingModalOpen] = useState(false);
  const [selectedClientForMapping, setSelectedClientForMapping] = useState<Client | null>(null);
  const [mappingForm, setMappingForm] = useState<Client['hierarchy'] | null>(null);
  const [mappingLeadSource, setMappingLeadSource] = useState<number | ''>('');
  const [applyToHistorical, setApplyToHistorical] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  // Gap filters: the four questions an operator asks after every import.
  const [gapFilter, setGapFilter] = useState<'' | 'noRm' | 'noBm' | 'noFolios'>('');
  const [showUnmappedFolios, setShowUnmappedFolios] = useState(false);
  const [unmappedFolios, setUnmappedFolios] = useState<any[] | null>(null);
  const [unmappedBusy, setUnmappedBusy] = useState(false);
  const [folioPick, setFolioPick] = useState<Record<string, string>>({});
  const [folioFixing, setFolioFixing] = useState<string | null>(null);

  const [isUserClientsModalOpen, setIsUserClientsModalOpen] = useState(false);
  const [selectedUserForClientList, setSelectedUserForClientList] = useState<TeamMember | null>(null);
  const [teamSearchTerm, setTeamSearchTerm] = useState('');

  const [clientPage, setClientPage] = useState(1);
  const [amcPage, setAmcPage] = useState(1);
  const [schemePage, setSchemePage] = useState(1);
  const [modalClientPage, setModalClientPage] = useState(1);
  const pageSize = 50;

  const [selectedClientIds, setSelectedClientIds] = useState<Set<string>>(new Set());
  const [bulkLevel, setBulkLevel] = useState<number | null>(null);
  const [bulkUserId, setBulkUserId] = useState<string>('');

  const isFinance = currentUser.role === Role.FINANCE;

  // AUM used to be read straight off `client.totalAum`, a value written ONLY when a
  // WBR9 / MFSD211 folio master is imported. The most recent one loaded was May's,
  // and it covered a single investor of this RM's seven — so six rows showed "—" and
  // the seventh showed a two-month-old ₹1,000 against a real ₹11,252. It comes from
  // the transactions now, through the one shared rule in utils/clientAum — shared
  // precisely because this page and the Reports client-summary tab each had their
  // own copy of it and drifted apart.
  const { aum: liveAum, clientsWithTx } = useClientAum(transactions);

  // One place decides a client's AUM, so the table, the sort and the export can
  // never disagree. The stored folio-master figure is the last fallback.
  const aumOf = (c: Client): { total: number; asOf: string; source: string } => {
    const live = liveAum.get(c.id);
    if (live) return { total: live.total, asOf: live.asOf, source: 'LIVE' };
    return { total: Number(c.totalAum) || 0, asOf: c.aumAsOf || '', source: c.aumSource || '' };
  };

  const filteredClients = useMemo(() => {
    return clients
      .filter(c => {
        let hasAccess = false;

        if (isAdmin || isFinance) {
          // Finance needs firm-wide visibility for payment cross-checks (read-only).
          hasAccess = true;
        } else {
          const h = c.hierarchy || {};
          const userLevelKey = `level${currentUser.level}Id` as keyof typeof h;
          hasAccess = h[userLevelKey] === currentUser.id;
        }
        if (!hasAccess) return false;
        if (gapFilter) {
          const hh: any = c.hierarchy || {};
          let rmLevel = 0;
          for (let l = 1; l <= 7; l++) if (hh[`level${l}Id`]) { rmLevel = l; break; }
          if (gapFilter === 'noRm' && rmLevel !== 0) return false;
          if (gapFilter === 'noBm') {
            let bm = 0;
            for (let l = rmLevel + 1; l <= 7; l++) if (hh[`level${l}Id`]) { bm = l; break; }
            if (bm !== 0) return false;
          }
          if (gapFilter === 'noFolios' && (c.folios || []).filter(Boolean).length > 0) return false;
        }
        return c.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          c.pan.toLowerCase().includes(searchTerm.toLowerCase());
      })
      // Sort by AUM desc by default — biggest clients first
      .sort((a, b) => aumOf(b).total - aumOf(a).total);
  }, [clients, searchTerm, currentUser, isAdmin, gapFilter, liveAum]);

  const openTeamModal = (member?: TeamMember) => {
    if (!isAdmin) return;
    if (member) {
      setEditingMember(member);
      setMemberForm({
        ...member,
        sharingRate: String(member.customLevels?.[member.level as keyof typeof member.customLevels] || 0),
        rateEffectiveFrom: new Date().toISOString().slice(0, 7),   // default: from this month forward
        bankDetails: member.bankDetails || { accountName: '', accountNumber: '', bankName: '', ifscCode: '', branch: '' },
        address: member.address || { street: '', city: '', state: '', pincode: '', country: 'India' }
      } as any);
    } else {
      setEditingMember(null);
      setMemberForm({
        name: '', code: '', role: Role.OPS, level: 1, email: '', password: '',
        parentId: '', sharingRate: '0', gstNumber: '',
        bankDetails: { accountName: '', accountNumber: '', bankName: '', ifscCode: '', branch: '' },
        address: { street: '', city: '', state: '', pincode: '', country: 'India' }
      });
    }
    setIsTeamModalOpen(true);
  };

  const saveTeamMember = async (andRecalc = false) => {
    if (!memberForm.name || !memberForm.code || !memberForm.email) {
      showToast("Required fields: Name, Code and Email.", 'warning');
      return;
    }
    // A password is required only when CREATING a user. For an EXISTING one the
    // field is intentionally blank: the API no longer returns password hashes
    // (they were being served to every logged-in user), so requiring it here
    // blocked every edit of an existing member — bank details and address
    // appeared to save and never reached the server. Leaving it empty makes the
    // upsert preserve the stored hash; typing a value changes the password.
    if (!editingMember && !memberForm.password) {
      showToast("Set a password for the new user.", 'warning');
      return;
    }
    // The sharing % is a share OF GROSS and is paid verbatim by all four payout
    // engines — there was no validation at all, so a mistyped "750" (or a negative)
    // saved silently and paid 750% of gross on every one of that RM's transactions
    // until someone noticed in a report. Bound it before it can reach the engines.
    // An empty box means "no override" (0), not an error — only a genuinely
    // non-numeric or out-of-range entry should block the save. A NaN here would
    // silently reject every edit, which is the exact failure mode this whole
    // screen has now hit twice.
    const rateRaw = String(memberForm.sharingRate ?? '').trim();
    const rateNum = rateRaw === '' ? 0 : Number(rateRaw);
    if (!Number.isFinite(rateNum) || rateNum < 0 || rateNum > 100) {
      showToast(`Sharing % must be between 0 and 100. You entered "${memberForm.sharingRate}".`, 'warning');
      return;
    }
    // A single RM taking >75% of gross, on top of the +25% lead-source bonus, leaves
    // nothing for the upline or the company — almost always a typo, so confirm it.
    if (rateNum > 75) {
      const ok = await showConfirm({
        title: 'Unusually high sharing rate',
        message: `${rateNum}% of gross is very high — with the ${globalConfig.leadSourcePct ?? 0}% lead-source bonus this RM could receive ${rateNum + (globalConfig.leadSourcePct ?? 0)}% of gross, leaving little or nothing for the upline and the company. Save anyway?`,
        confirmText: 'Save anyway',
        variant: 'warning',
      });
      if (!ok) return;
    }
    const finalMember: TeamMember = {
      ...(editingMember || {}),
      id: editingMember?.id || `tm_${Date.now()}`,
      name: memberForm.name!,
      code: memberForm.code!,
      role: memberForm.role || Role.OPS,
      level: memberForm.level ?? 6,
      roles: (memberForm.roles && memberForm.roles.length) ? [...memberForm.roles].sort((a, b) => a - b) : undefined,
      email: memberForm.email,
      password: memberForm.password,
      parentId: memberForm.parentId,
      gstNumber: memberForm.gstNumber,
      bankDetails: memberForm.bankDetails,
      address: memberForm.address,
      // Consumed by the server to stamp rateHistory; never stored as profile data.
      rateEffectiveFrom: memberForm.rateEffectiveFrom || thisMonth,
      customLevels: {
        ...(editingMember?.customLevels || {}),
        [memberForm.level ?? 6]: Number(memberForm.sharingRate || 0)
      }
    } as TeamMember;

    // Persist ONLY this member (never the whole team list — that would let a
    // stale tab revert everyone else's rates) and confirm it saved, THEN
    // recalculate — otherwise the recompute can run against the old rate.
    const saved = await upsertTeamMember(finalMember);
    if (!saved) {
      // saveToDb already surfaced the specific error; keep the modal open to retry.
      return;
    }
    setIsTeamModalOpen(false);

    if (andRecalc) {
      showToast('Saved. Recalculating payouts with the new sharing %…', 'info');
      const done = await recalculateAllTransactions();
      if (done) showToast('Done — payouts recalculated with the new sharing %.', 'success');
    } else {
      showToast('Saved. Tip: use “Save & Recalculate” to apply the new % across all payouts.', 'success');
    }
  };

  const openClientModal = (client?: Client) => {
    if (!isAdmin) return;
    if (client) {
      setEditingClient(client);
      setClientForm(client);
      setFolioText((client.folios || []).join(', '));
    } else {
      setEditingClient(null);
      setClientForm({ name: '', pan: '', folios: [] });
      setFolioText('');
    }
    setIsClientModalOpen(true);
  };

  const isValidPAN = (v: string) => /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(v);

  const saveClient = async () => {
    if (!clientForm.name || !clientForm.pan) {
      showToast("Required fields: Name and PAN.", 'warning');
      return;
    }
    // Format first — a mistyped PAN must never trigger the family-member prompt.
    if (!isValidPAN(clientForm.pan.toUpperCase())) {
      showToast('Invalid PAN format (e.g. ABCDE1234F)', 'warning');
      return;
    }

    // A shared PAN is NORMAL: a minor invests under the guardian's PAN, so
    // siblings legitimately share one (this book has 9 such families). Only the
    // SAME NAME on the SAME PAN is a real duplicate, and that is the only case
    // worth interrupting for. A different name is simply saved with a note —
    // prompting there made adding a second child feel like a rejection.
    if (!editingClient && clientForm.pan) {
      const pan = clientForm.pan.toUpperCase().trim();
      const nk = (v?: string) => String(v || '').toUpperCase()
        .replace(/\b(MR|MRS|MS|MISS|DR|SHRI|SMT|LATE)\b\.?/g, ' ')
        .replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
        .split(' ').filter(Boolean).sort().join(' ');
      const sharing = clients.filter(c => String(c.pan || '').toUpperCase().trim() === pan);
      const sameName = sharing.filter(c => nk(c.name) === nk(clientForm.name));
      if (sameName.length) {
        const go = await showConfirm({
          title: 'This client already exists',
          message: `"${sameName[0].name}" is already on file with PAN ${pan}. Adding a second record for the same person splits their folios and brokerage across two clients.\n\nEdit the existing record instead — unless this genuinely is a different person who happens to share the name.`,
          confirmText: 'Add anyway',
          variant: 'warning',
        });
        if (!go) return;
      } else if (sharing.length) {
        // Family member on a shared PAN — save it, just say what happened.
        showToast(`PAN ${pan} is also held by ${sharing.map(c => c.name).join(', ')} — saving as a separate investor (normal for a minor under a guardian's PAN).`, 'info');
      }
    }
    if (editingClient) {
      updateClients(clients.map(c => c.id === editingClient.id ? { ...c, ...clientForm } as Client : c));
    } else {
      const newClient: Client = {
        name: clientForm.name!,
        pan: clientForm.pan!,
        email: clientForm.email,
        mobile: clientForm.mobile,
        id: `c_${Date.now()}`,
        folios: clientForm.folios || [],
        hierarchy: {
          // No owner yet. This used to be 'tm1', a team id that does NOT exist,
          // so a new client looked assigned while earning nobody anything (the
          // same ghost that had to be cleared off 239 clients). Empty shows
          // honestly as "Unassigned" until someone maps them.
          level1Id: '', level2Id: '', level3Id: '', level4Id: '', level5Id: '', level6Id: '', level7Id: ''
        }
      };
      updateClients([...clients, newClient]);
    }
    setIsClientModalOpen(false);
  };

  const handleCopyCredentials = (member: TeamMember) => {
    const text = `System Access:\nEmail: ${member.email}\nEmployee Code: ${member.code}`;
    navigator.clipboard.writeText(text);
    setCopiedId(member.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const openMappingModal = (client: Client) => {
    if (!isAdmin) return;
    setSelectedClientForMapping(client);
    setMappingForm({ ...client.hierarchy });
    setMappingLeadSource(client.leadSourceLevel || '');
    setIsMappingModalOpen(true);
  };

  const saveMapping = () => {
    if (selectedClientForMapping && mappingForm) {
      // Note: the SAME person may hold several rungs on one client — that is how
      // the cumulative model lets them earn the full stack up to their level
      // (gross is still counted once per user). So no single-level restriction.
      const leadSourceLevel = mappingLeadSource === '' ? undefined : Number(mappingLeadSource);
      updateClients(clients.map(c =>
        c.id === selectedClientForMapping.id ? { ...c, hierarchy: mappingForm, leadSourceLevel } : c
      ));
      if (applyToHistorical) {
        recalculateAllTransactions();
      }
      setIsMappingModalOpen(false);
    }
  };

  const openUserClientsModal = (member: TeamMember) => {
    setSelectedUserForClientList(member);
    setModalClientPage(1);
    setIsUserClientsModalOpen(true);
  };

  const handleQuickReassign = (clientId: string, level: number, newUserId: string) => {
    updateClients(clients.map(c => {
      if (c.id === clientId) {
        return {
          ...c,
          hierarchy: {
            ...c.hierarchy,
            [`level${level}Id`]: newUserId
          }
        };
      }
      return c;
    }));
  };

  const toggleClientSelection = (id: string) => {
    setSelectedClientIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAllVisible = () => {
    const visibleIds = filteredClients.slice((clientPage - 1) * pageSize, clientPage * pageSize).map(c => c.id);
    const allSelected = visibleIds.every(id => selectedClientIds.has(id));

    setSelectedClientIds(prev => {
      const next = new Set(prev);
      if (allSelected) {
        visibleIds.forEach(id => next.delete(id));
      } else {
        visibleIds.forEach(id => next.add(id));
      }
      return next;
    });
  };

  const handleBulkMap = async () => {
    if (bulkLevel === null || !bulkUserId) {
      showToast("Please select level and user for assignment.", 'warning');
      return;
    }
    if (selectedClientIds.size === 0) return;

    const confirmed = await showConfirm({
      title: 'Bulk Assignment',
      message: `Assign ${selectedClientIds.size} clients to ${team.find(t => t.id === bulkUserId)?.name} as L${bulkLevel}?`,
      confirmText: 'Assign Now',
      variant: 'info'
    });
    if (!confirmed) return;

    const updatedClients = clients.map(c => {
      if (selectedClientIds.has(c.id)) {
        return {
          ...c,
          hierarchy: {
            ...c.hierarchy,
            [`level${bulkLevel}Id`]: bulkUserId
          }
        };
      }
      return c;
    });

    updateClients(updatedClients);
    if (applyToHistorical) {
      recalculateAllTransactions();
    }
    setSelectedClientIds(new Set());
    setBulkLevel(null);
    setBulkUserId('');
    showToast(`Bulk assignment complete.${applyToHistorical ? ' Historical payouts recalculated.' : ''}`, 'success');
  };

  const handleBulkDelete = async () => {
    if (selectedClientIds.size === 0) return;
    const confirmed = await showConfirm({
      title: 'Bulk Delete Clients',
      message: `Permanently delete ${selectedClientIds.size} selected client${selectedClientIds.size !== 1 ? 's' : ''}? This cannot be undone.`,
      confirmText: `Delete ${selectedClientIds.size} Client${selectedClientIds.size !== 1 ? 's' : ''}`,
      variant: 'danger'
    });
    if (!confirmed) return;
    const remaining = clients.filter(c => !selectedClientIds.has(c.id));
    updateClients(remaining);
    setSelectedClientIds(new Set());
    showToast(`${selectedClientIds.size} client${selectedClientIds.size !== 1 ? 's' : ''} deleted.`, 'success');
  };

  // ── Manual merge ────────────────────────────────────────────────────────
  // Duplicates usually sit under DIFFERENT RMs, so a merge silently decides whose
  // book the investor lands in. Rather than inferring that from whichever record
  // was clicked, open a panel: pick the record to keep, see what each one holds,
  // and pick the RM explicitly. Nothing is written until Merge is pressed.
  type MergeGroup = { pan: string; records: Client[] };
  const [mergePanel, setMergePanel] = useState<MergeGroup | null>(null);
  const [mergeMasterId, setMergeMasterId] = useState('');
  const [mergeRmId, setMergeRmId] = useState('');
  const [mergeStats, setMergeStats] = useState<Record<string, { txCount: number; gross: number; rm: string | null }>>({});
  const [mergeBusy, setMergeBusy] = useState(false);
  // A PAN group is not always one person: it can hold two genuinely different
  // investors AND a duplicate of one of them. So the operator picks WHICH records
  // take part; anything unticked is left completely untouched.
  const [mergeInclude, setMergeInclude] = useState<Set<string>>(new Set());

  const ownerOfClient = (c: Client): TeamMember | undefined => {
    const h: any = c.hierarchy || {};
    for (let l = 1; l <= 7; l++) if (h[`level${l}Id`]) return team.find(t => t.id === h[`level${l}Id`]);
    return undefined;
  };

  // The BM is the next assigned level ABOVE whoever owns the client -- the same
  // rule the reconciliation export uses, so the two never disagree.
  const bmOfClient = (c: Client): TeamMember | undefined => {
    const h: any = c.hierarchy || {};
    const rm = ownerOfClient(c);
    for (let l = (rm?.level || 0) + 1; l <= 7; l++) {
      if (h[`level${l}Id`]) return team.find(t => t.id === h[`level${l}Id`]);
    }
    return undefined;
  };

  // Counts are over every client this user may see, NOT over the current search,
  // so the numbers stay put while typing in the search box.
  const gapCounts = useMemo(() => {
    const visible = clients.filter(c => {
      if (isAdmin || isFinance) return true;
      const h: any = c.hierarchy || {};
      return h[`level${currentUser.level}Id`] === currentUser.id;
    });
    let noRm = 0, noBm = 0, noFolios = 0;
    for (const c of visible) {
      if (!ownerOfClient(c)) noRm++;
      if (!bmOfClient(c)) noBm++;
      if (!(c.folios || []).filter(Boolean).length) noFolios++;
    }
    return { total: visible.length, noRm, noBm, noFolios };
  }, [clients, team, currentUser, isAdmin, isFinance]);

  const loadUnmappedFolios = async () => {
    setUnmappedBusy(true);
    try {
      const r = await authFetch(`/api/data?action=exceptions_report&_=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) { showToast('Could not load unmapped folios.', 'error'); return; }
      const j = await r.json();
      setUnmappedFolios(j.unmappedTx || []);
    } catch {
      showToast('Could not load unmapped folios.', 'error');
    } finally {
      setUnmappedBusy(false);
    }
  };

  const attachFolio = async (rowKey: string, folio: string, toClientId: string) => {
    setFolioFixing(rowKey);
    try {
      const r = await authFetch('/api/data', {
        method: 'POST',
        body: JSON.stringify({ action: 'exception_fix', op: 'repoint', folio, toClientId }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) { showToast(j.error || 'Could not attach that folio.', 'error'); return; }
      showToast(j.message || 'Folio attached.', 'success');
      await loadUnmappedFolios();
    } catch {
      showToast('Could not attach that folio.', 'error');
    } finally {
      setFolioFixing(null);
    }
  };

  const openMergePanel = async (records: Client[]) => {
    if (!records.length) return;
    // Default to the record holding the most history — losing that costs the most.
    setMergePanel({ pan: records[0].pan, records });
    setMergeStats({});
    setMergeBusy(true);
    try {
      const pre = await authFetch('/api/data', {
        method: 'POST',
        body: JSON.stringify({
          action: 'merge_clients',
          masterId: records[0].id,
          duplicateIds: records.slice(1).map(r => r.id),
          dryRun: true,
        }),
      }).then((r: Response) => r.json());
      const stats: Record<string, { txCount: number; gross: number; rm: string | null }> = {};
      if (pre?.summary) {
        stats[pre.summary.master.id] = { txCount: pre.summary.master.txCount, gross: pre.summary.master.gross, rm: pre.summary.master.rm };
        (pre.summary.merging || []).forEach((d: any) => { stats[d.id] = { txCount: d.txCount, gross: d.gross, rm: d.rm }; });
      }
      setMergeStats(stats);
      const richest = [...records].sort((a, b) => (stats[b.id]?.txCount || 0) - (stats[a.id]?.txCount || 0))[0];
      setMergeMasterId(richest.id);
      setMergeRmId(ownerOfClient(richest)?.id || '');
      setMergeInclude(new Set(records.map(r => r.id)));
    } catch {
      setMergeMasterId(records[0].id);
      setMergeRmId(ownerOfClient(records[0])?.id || '');
      setMergeInclude(new Set(records.map(r => r.id)));
    } finally { setMergeBusy(false); }
  };

  const runMerge = async () => {
    if (!mergePanel || !mergeMasterId) return;
    const dupes = mergePanel.records
      .filter(r => r.id !== mergeMasterId && mergeInclude.has(r.id))
      .map(r => r.id);
    if (!dupes.length) { showToast('Tick at least one record to merge INTO the one you are keeping.', 'warning'); return; }
    const master = mergePanel.records.find(r => r.id === mergeMasterId)!;
    const movingTx = dupes.reduce((s, id) => s + (mergeStats[id]?.txCount || 0), 0);
    const movingGross = dupes.reduce((s, id) => s + (mergeStats[id]?.gross || 0), 0);
    const rmName = team.find(t => t.id === mergeRmId)?.name || 'unchanged';

    const ok = await showConfirm({
      title: `Merge ${dupes.length} record(s) into "${master.name}"?`,
      message:
        `${movingTx} transaction(s) worth ₹${movingGross.toFixed(2)} will move to the kept record, and the other ` +
        `${dupes.length} record(s) will be deleted permanently.\n\n` +
        `The merged client will belong to: ${rmName}.\n\n` +
        `Payouts recalculate afterwards. This cannot be undone.`,
      confirmText: 'Merge',
      variant: 'danger',
    });
    if (!ok) return;

    setMergeBusy(true);
    try {
      const res = await authFetch('/api/data', {
        method: 'POST',
        body: JSON.stringify({
          action: 'merge_clients',
          masterId: mergeMasterId,
          duplicateIds: dupes,
          rmId: mergeRmId || undefined,
          dryRun: false,
        }),
      }).then((r: Response) => r.json());
      if (!res?.success) throw new Error(res?.error || 'Merge failed');
      showToast(`Merged into "${master.name}". ${movingTx} transaction(s) moved. Payouts are recalculating.`, 'success');
      setMergePanel(null);
    } catch (err: any) {
      showToast(`Merge failed: ${err?.message || err}`, 'error');
    } finally { setMergeBusy(false); }
  };

  const handleMergeClients = async (masterId: string, duplicateIds: string[]) => {
    const all = [masterId, ...duplicateIds]
      .map(id => clients.find(c => c.id === id))
      .filter(Boolean) as Client[];
    await openMergePanel(all);
  };

  const handleExportClients = () => {
    const data = filteredClients.map(c => {
      const hierarchy = c.hierarchy || {};
      // Walk hierarchy from the LOWEST assigned level upward so the column shows
      // the *direct* relationship manager (e.g. the Sherpa actually handling the
      // client), not the Master Sherpa / Holding above them.
      const assignedLevels = [1, 2, 3, 4, 5, 6, 7];
      let assignedUser: TeamMember | undefined;

      for (const level of assignedLevels) {
        const userId = hierarchy[`level${level}Id` as keyof typeof hierarchy];
        if (userId) {
          assignedUser = team.find(t => t.id === userId);
          if (assignedUser) break;
        }
      }

      return {
        'Client Name': c.name,
        'PAN': c.pan,
        'Mobile': c.mobile || '',
        'Email': c.email || '',
        'Assigned User': assignedUser ? assignedUser.name : 'Unassigned',
        'User Level': assignedUser ? `L${assignedUser.level}` : '',
        'Folios': c.folios.join(', '),
        'AUM (Rs.)': aumOf(c).total ? Math.round(aumOf(c).total) : '',
        'AUM Source': aumOf(c).source,
        'AUM As Of': aumOf(c).asOf,
      };
    });

    exportToExcel(data, `Wealthflow_Clients_${new Date().toISOString().split('T')[0]}`, 'Clients');
  };

  const duplicateGroups = useMemo(() => {
    if (!isAdmin) return [];

    const results: { type: string, value: string, group: Client[] }[] = [];
    const processedIds = new Set<string>();

    const checkField = (field: keyof Client, label: string) => {
      const map: Record<string, Client[]> = {};
      clients.forEach(c => {
        const val = String(c[field] || '').toUpperCase().trim();
        if (!val || val === 'UNKNOWN' || val === 'NONE') return;
        if (!map[val]) map[val] = [];
        map[val].push(c);
      });

      Object.entries(map).forEach(([val, group]) => {
        if (group.length > 1) {
          results.push({ type: label, value: val, group });
        }
      });
    };

    checkField('pan', 'PAN Card');
    checkField('mobile', 'Mobile No');
    checkField('email', 'Email Address');
    checkField('name', 'Exact Name');

    return results;
  }, [clients, isAdmin]);

  return (
    <div className="space-y-6 text-slate-900 dark:text-slate-100">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">{isAdmin ? 'Enterprise Management' : 'Linked Portfolios'}</h1>
          <p className="text-slate-500 dark:text-slate-400 mt-1 font-medium">
            {isAdmin ? 'System-wide client mapping and hierarchy control.' : 'Your active investors and mapped schemes.'}
          </p>
        </div>
        <div className="flex space-x-2 bg-white p-1 rounded-xl border border-slate-200 shadow-sm">
          {isAdmin && (
            <button onClick={() => { setActiveTab('hierarchy'); setClientPage(1); }} className={`flex items-center px-4 py-2 text-[10px] font-black uppercase tracking-widest rounded-lg transition ${activeTab === 'hierarchy' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-slate-900'}`}><Shield className="w-3.5 h-3.5 mr-2" />Hierarchy</button>
          )}
          <button onClick={() => { setActiveTab('clients'); setClientPage(1); }} className={`flex items-center px-4 py-2 text-[10px] font-black uppercase tracking-widest rounded-lg transition ${activeTab === 'clients' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-slate-900'}`}><Users className="w-3.5 h-3.5 mr-2" />Clients</button>
          {isAdmin && (
            <button onClick={() => { setActiveTab('standardize'); setClientPage(1); setAmcPage(1); setSchemePage(1); }} className={`flex items-center px-4 py-2 text-[10px] font-black uppercase tracking-widest rounded-lg transition ${activeTab === 'standardize' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-slate-900'}`}><Database className="w-3.5 h-3.5 mr-2" />Standardize</button>
          )}
        </div>
      </div>

      {activeTab === 'hierarchy' && isAdmin && (
        <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden animate-in fade-in">
          <div className="p-6 border-b border-slate-200 flex flex-col md:flex-row justify-between items-center bg-slate-50 gap-4">
            <div className="flex flex-col md:flex-row md:items-center gap-4 w-full md:w-auto">
              <h3 className="text-sm font-black text-slate-800 uppercase tracking-widest whitespace-nowrap">Active System Accounts</h3>
              <div className="relative w-full md:w-64">
                <Search className="absolute left-3 top-2.5 text-slate-400 w-3.5 h-3.5" />
                <input
                  type="text"
                  placeholder="Search user name or email..."
                  value={teamSearchTerm}
                  onChange={(e) => setTeamSearchTerm(e.target.value)}
                  className="pl-9 pr-4 py-2 w-full border border-slate-200 rounded-xl text-[10px] font-black uppercase tracking-widest focus:ring-2 focus:ring-blue-500 bg-white"
                />
              </div>
            </div>
            <button onClick={() => openTeamModal()} className="bg-blue-600 text-white px-5 py-2 rounded-xl text-xs font-black uppercase tracking-widest hover:bg-blue-700 flex items-center shadow-lg shadow-blue-50 transition w-full md:w-auto justify-center"><UserPlus className="w-3.5 h-3.5 mr-2" />New User Account</button>
          </div>
          <table className="w-full text-sm text-left">
            <thead className="bg-white text-slate-400 font-black border-b border-slate-200 uppercase tracking-widest text-[9px]">
              <tr>
                <th className="px-6 py-4">User Details</th>
                <th className="px-6 py-4">Role & Level</th>
                <th className="px-6 py-4">Mapped Clients</th>
                <th className="px-6 py-4">Credentials</th>
                <th className="px-6 py-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-700/50">
              {team.filter(m =>
                m.name.toLowerCase().includes(teamSearchTerm.toLowerCase()) ||
                m.email?.toLowerCase().includes(teamSearchTerm.toLowerCase()) ||
                m.code?.toLowerCase().includes(teamSearchTerm.toLowerCase())
              ).sort((a, b) => (a.level) - (b.level)).map((member) => (
                <tr key={member.id} className="hover:bg-slate-50 dark:hover:bg-slate-700/30 transition">
                  <td className="px-6 py-4">
                    <div className="font-bold text-slate-900">{member.name}</div>
                    <div className="text-xs text-slate-500">{member.email}</div>
                  </td>
                  <td className="px-6 py-4">
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-[9px] font-black uppercase bg-slate-100 text-slate-600 border border-slate-200 mr-2">{member.role}</span>
                    <span className="font-bold text-slate-600">L{member.level}</span>
                  </td>
                  <td className="px-6 py-4">
                    <button
                      onClick={() => openUserClientsModal(member)}
                      className="flex flex-col group text-left"
                    >
                      <span className="text-lg font-black text-blue-600 group-hover:text-blue-800 transition-colors">
                        {clients.filter(c => {
                          // "Mapped Clients" = clients where this user is the PRIMARY owner
                          // (the lowest-level assigned user). Upline mentors (Master Sherpa etc.)
                          // intentionally count zero — their oversight surfaces via downline
                          // metrics, not via direct-ownership counts.
                          if (!c.hierarchy) return false;
                          for (let l = 1; l <= 7; l++) {
                            const uid = c.hierarchy[`level${l}Id` as keyof typeof c.hierarchy];
                            if (!uid) continue;
                            return uid === member.id;
                          }
                          return false;
                        }).length}
                      </span>
                      <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest group-hover:text-slate-600">Direct Clients</span>
                    </button>
                  </td>
                  <td className="px-6 py-4">
                    <button onClick={() => handleCopyCredentials(member)} className={`flex items-center px-3 py-1.5 rounded-lg text-[10px] font-black uppercase transition border ${copiedId === member.id ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-blue-50 text-blue-600 border-blue-100 hover:bg-blue-100'}`}>
                      {copiedId === member.id ? <Check className="w-3 h-3 mr-2" /> : <Copy className="w-3 h-3 mr-2" />}
                      Copy Access
                    </button>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex items-center justify-end space-x-2">
                      <button onClick={() => openTeamModal(member)} className="p-2 text-slate-400 hover:text-blue-600"><Edit2 className="w-4 h-4" /></button>
                      <button
                        onClick={async () => {
                          // Deleting a member was a single unguarded click. Their id
                          // stays embedded in every client's hierarchy, so those slots
                          // become unpayable ghosts (244 such refs existed) — say so.
                          const owned = clients.filter(c => {
                            const h: any = c.hierarchy || {};
                            for (let l = 1; l <= 7; l++) if (h[`level${l}Id`] === member.id) return true;
                            return false;
                          }).length;
                          const ok = await showConfirm({
                            title: `Delete ${member.name}?`,
                            message: owned > 0
                              ? `${member.name} is assigned to ${owned} client${owned === 1 ? '' : 's'}. Deleting them leaves those clients pointing at a user that no longer exists, and that share of brokerage will be paid to nobody until each client is re-mapped. Their past payout records are kept. This cannot be undone.`
                              : `${member.name} has no clients assigned. Their past payout records are kept. This cannot be undone.`,
                            confirmText: 'Delete',
                            variant: 'danger',
                          });
                          if (ok) deleteTeamMember(member.id);
                        }}
                        disabled={member.id === currentUser.id}
                        className="p-2 text-slate-400 hover:text-red-600 disabled:opacity-20"><Trash2 className="w-4 h-4" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === 'clients' && (
        <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm flex flex-col h-[calc(100vh-14rem)]">
          <div className="p-4 border-b border-slate-200 flex flex-col sm:flex-row gap-4 justify-between bg-slate-50">
            <div className="relative w-full sm:max-w-md">
              <Search className="absolute left-3 top-2.5 text-slate-400 w-4 h-4" />
              <input type="text" placeholder="Search portfolios..." value={searchTerm} onChange={(e) => { setSearchTerm(e.target.value); setClientPage(1); }} className="pl-10 pr-4 py-2 w-full border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 bg-white dark:bg-slate-700 dark:text-slate-100 dark:border-slate-600 font-bold" />
            </div>
            <div className="flex items-center gap-2">
              {isAdmin && (
                <button
                  onClick={handleExportClients}
                  className="bg-emerald-600 text-white px-6 py-2 rounded-xl text-xs font-black uppercase tracking-widest hover:bg-emerald-700 shadow-lg shadow-emerald-50 transition flex items-center"
                >
                  <Download className="w-4 h-4 mr-2" /> Export
                </button>
              )}
              {isAdmin && (
                <button onClick={() => openClientModal()} className="bg-blue-600 text-white px-6 py-2 rounded-xl text-xs font-black uppercase tracking-widest hover:bg-blue-700 shadow-lg shadow-blue-50 transition flex items-center"><Plus className="w-4 h-4 mr-2" /> Add Client</button>
              )}
            </div>
          </div>
          {/* ── Gap filters: what still needs a human after an import ── */}
          <div className="px-6 pb-4 flex flex-wrap items-center gap-2">
            {([
              ['', 'All clients', gapCounts.total],
              ['noRm', 'No RM', gapCounts.noRm],
              ['noBm', 'No BM', gapCounts.noBm],
              ['noFolios', 'No folios', gapCounts.noFolios],
            ] as [typeof gapFilter, string, number][]).map(([key, label, n]) => {
              const active = !showUnmappedFolios && gapFilter === key;
              const clean = key !== '' && n === 0;
              return (
                <button
                  key={label}
                  onClick={() => { setGapFilter(key); setShowUnmappedFolios(false); setClientPage(1); }}
                  className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest border transition ${active
                    ? 'bg-blue-600 text-white border-blue-600 shadow-lg shadow-blue-100'
                    : clean
                      ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/10 dark:text-emerald-300 dark:border-emerald-800'
                      : 'bg-white text-slate-600 border-slate-200 hover:border-blue-400 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-600'}`}
                >
                  {label} <span className={`ml-1.5 ${active ? 'text-blue-100' : clean ? 'text-emerald-600' : 'text-slate-400'}`}>{n}</span>
                </button>
              );
            })}
            <button
              onClick={() => {
                const next = !showUnmappedFolios;
                setShowUnmappedFolios(next);
                if (next && unmappedFolios === null) loadUnmappedFolios();
              }}
              className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest border transition ${showUnmappedFolios
                ? 'bg-amber-600 text-white border-amber-600 shadow-lg shadow-amber-100'
                : 'bg-white text-amber-700 border-amber-300 hover:border-amber-500 dark:bg-slate-800 dark:text-amber-300 dark:border-amber-700'}`}
            >
              Folios with no client
              <span className={`ml-1.5 ${showUnmappedFolios ? 'text-amber-100' : 'text-amber-500'}`}>
                {unmappedBusy ? '…' : unmappedFolios === null ? '?' : unmappedFolios.length}
              </span>
            </button>
            {gapFilter !== '' && !showUnmappedFolios && (
              <span className="text-[10px] font-bold text-slate-400">
                Use <span className="text-blue-600">Map Account</span> to set the RM/BM, or the pencil to edit the client and its folios.
              </span>
            )}
          </div>
          {showUnmappedFolios ? (
            <div className="overflow-auto flex-1 px-6 pb-6">
              <p className="text-[11px] text-slate-600 dark:text-slate-400 mb-3">
                These folios carry brokerage but belong to no client, so nobody is credited for them.
                Pick the investor each one belongs to and press Attach — the folio's transactions move to
                that client and follow their RM. Settled months are frozen and are left alone.
              </p>
              {unmappedBusy && <div className="text-xs font-bold text-slate-400 py-6">Loading…</div>}
              {!unmappedBusy && unmappedFolios !== null && unmappedFolios.length === 0 && (
                <div className="text-xs font-black uppercase tracking-widest text-emerald-600 py-6">
                  Every folio is attached to a client. Nothing to fix here.
                </div>
              )}
              {!unmappedBusy && !!unmappedFolios?.length && (
                <table className="w-full text-[11px] text-left">
                  <thead className="bg-white dark:bg-slate-800 text-slate-400 font-black border-b border-slate-200 dark:border-slate-700 sticky top-0 uppercase tracking-widest text-[9px]">
                    <tr>
                      <th className="px-3 py-3">Period</th>
                      <th className="px-3 py-3">Folio</th>
                      <th className="px-3 py-3">Investor on the file</th>
                      <th className="px-3 py-3">PAN</th>
                      <th className="px-3 py-3">AMC</th>
                      <th className="px-3 py-3 text-right">Rows</th>
                      <th className="px-3 py-3 text-right">Gross</th>
                      <th className="px-3 py-3 w-80">Attach to client</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {unmappedFolios.slice(0, 400).map((r: any, i: number) => {
                      const key = `uf-${i}`;
                      const busy = folioFixing === key;
                      return (
                        <tr key={key} className="hover:bg-amber-50/40 dark:hover:bg-amber-900/10">
                          <td className="px-3 py-2 font-mono">{r.period}</td>
                          <td className="px-3 py-2 font-mono font-black">{r.folio || '—'}</td>
                          <td className="px-3 py-2 font-bold">{r.investorName}</td>
                          <td className="px-3 py-2 font-mono text-slate-500">{r.pan || '—'}</td>
                          <td className="px-3 py-2 text-slate-500">{r.amcName}</td>
                          <td className="px-3 py-2 text-right font-bold">{r.rows}</td>
                          <td className="px-3 py-2 text-right font-bold">₹{Number(r.gross || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                          <td className="px-3 py-2">
                            {!r.folio ? (
                              <span className="text-[10px] text-slate-500">No folio on this row — fix it on the transaction.</span>
                            ) : (
                              <div className="flex gap-1">
                                <select
                                  value={folioPick[key] || ''}
                                  onChange={e => setFolioPick({ ...folioPick, [key]: e.target.value })}
                                  className="flex-1 min-w-0 px-2 py-1.5 rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-[11px] font-bold"
                                >
                                  <option value="">— pick the investor —</option>
                                  {clients.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''))
                                    .map(c => (
                                      <option key={c.id} value={c.id}>
                                        {c.name}{c.pan ? ` — ${c.pan}` : ''}
                                      </option>
                                    ))}
                                </select>
                                <button
                                  disabled={busy || !folioPick[key] || !isAdmin}
                                  onClick={() => attachFolio(key, r.folio, folioPick[key])}
                                  className="px-3 py-1.5 rounded-lg bg-amber-600 text-white text-[10px] font-black uppercase disabled:opacity-40"
                                >{busy ? '…' : 'Attach'}</button>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              {!!unmappedFolios && unmappedFolios.length > 400 && (
                <p className="text-[10px] text-slate-500 mt-3">
                  Showing the first 400 of {unmappedFolios.length}. The full list is in Reports → Exceptions → Download Excel.
                </p>
              )}
            </div>
          ) : (
          <div className="overflow-auto flex-1">
            <table className="w-full text-sm text-left">
              <thead className="bg-white text-slate-400 font-black border-b border-slate-200 sticky top-0 z-10 uppercase tracking-widest text-[9px]">
                <tr>
                  <th className="px-6 py-4 w-10">
                    <input
                      type="checkbox"
                      className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                      checked={filteredClients.slice((clientPage - 1) * pageSize, clientPage * pageSize).length > 0 && filteredClients.slice((clientPage - 1) * pageSize, clientPage * pageSize).every(c => selectedClientIds.has(c.id))}
                      onChange={toggleSelectAllVisible}
                    />
                  </th>
                  <th className="px-6 py-4">Investor Identity</th>
                  <th className="px-6 py-4">PAN / Folios</th>
                  <th className="px-6 py-4 text-right">AUM</th>
                  {isAdmin && <th className="px-6 py-4">Assigned Manager / Owner</th>}
                  <th className="px-6 py-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-700/50">
                {filteredClients.slice((clientPage - 1) * pageSize, clientPage * pageSize).map((client) => {
                  const hierarchy = client.hierarchy || {};
                  // Lowest-level FIRST so the column shows the direct relationship
                  // manager (Sherpa at L3) instead of the Master Sherpa / Holding
                  // sitting above them in the hierarchy.
                  const assignedLevels = [1, 2, 3, 4, 5, 6, 7];
                  let assignedUser: TeamMember | undefined;

                  for (const level of assignedLevels) {
                    const userId = hierarchy[`level${level}Id` as keyof typeof hierarchy];
                    if (userId) {
                      assignedUser = team.find(t => t.id === userId);
                      if (assignedUser) break;
                    }
                  }

                  return (
                    <tr key={client.id} className={`hover:bg-slate-50 transition ${selectedClientIds.has(client.id) ? 'bg-blue-50/50' : ''}`}>
                      <td className="px-6 py-4">
                        <input
                          type="checkbox"
                          className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                          checked={selectedClientIds.has(client.id)}
                          onChange={() => toggleClientSelection(client.id)}
                        />
                      </td>
                      <td className="px-6 py-4">
                        <div className="font-bold text-slate-900">{client.name}</div>
                        <div className="text-[10px] text-blue-500 font-black uppercase tracking-tighter mt-0.5">{client.pan}</div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="text-xs text-slate-500 font-bold truncate max-w-[200px]">{client.folios.join(', ')}</div>
                        <div className="text-[9px] text-slate-400 uppercase font-black tracking-widest mt-0.5">{client.folios.length} Linked Folios</div>
                      </td>
                      <td className="px-6 py-4 text-right">
                        {(() => {
                          const a = aumOf(client);
                          if (!(a.total > 0)) {
                            // A bare dash left an RM unable to tell a system problem
                            // from a missing import. Mohammad Sadik's folio
                            // 43908946/35 appears in no file we have ever loaded —
                            // nine clients firm-wide are in that position — so say so
                            // rather than showing nothing and letting it read as a bug.
                            const known = clientsWithTx ? clientsWithTx.has(client.id) : null;
                            return (
                              <>
                                <span className="text-slate-300 dark:text-slate-600 text-xs">—</span>
                                {known === false && (
                                  <div className="text-[9px] text-amber-600 dark:text-amber-400 font-bold uppercase tracking-widest mt-0.5">
                                    Not in any import
                                  </div>
                                )}
                              </>
                            );
                          }
                          const label = a.source === 'LIVE' ? 'Latest' : a.source === 'WBR9' ? 'Snapshot' : 'Estimated';
                          return (
                            <>
                              <div className={`font-black ${a.source === 'LIVE' || a.source === 'WBR9' ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-700 dark:text-slate-300'}`}>
                                {formatCompactINR(a.total)}
                              </div>
                              <div className="text-[9px] text-slate-400 font-bold uppercase tracking-widest mt-0.5">
                                {label}{a.asOf ? ` · ${a.asOf}` : ''}
                              </div>
                            </>
                          );
                        })()}
                      </td>
                      {isAdmin && (
                        <td className="px-6 py-4">
                          {assignedUser ? (
                            <div className="flex flex-col">
                              <span className="text-slate-900 font-bold">{assignedUser.name}</span>
                              <span className="text-[9px] font-black uppercase text-blue-500 tracking-widest">Level {assignedUser.level}</span>
                            </div>
                          ) : (
                            <span className="text-amber-500 italic font-bold">Unassigned</span>
                          )}
                        </td>
                      )}
                      <td className="px-6 py-4 text-right">
                        <div className="flex items-center justify-end space-x-2">
                          {isAdmin && (
                            <button onClick={() => openMappingModal(client)} className="text-blue-600 hover:text-blue-800 font-black text-[9px] uppercase tracking-widest border border-blue-200 hover:bg-blue-50 px-3 py-1.5 rounded-lg transition flex items-center shadow-sm"><UserCheck className="w-3.5 h-3.5 mr-2" /> Map Account</button>
                          )}
                          <button onClick={() => openClientModal(client)} className={`p-2 text-slate-400 hover:text-blue-600 ${!isAdmin && 'hidden'}`}><Edit2 className="w-4 h-4" /></button>
                          <button
                            onClick={async () => {
                              // Was a single unguarded click. Transactions keep the
                              // deleted client's id, so their brokerage stops being
                              // attributed to anyone.
                              const ok = await showConfirm({
                                title: `Delete ${client.name}?`,
                                message: `This removes the investor and their folio mapping (${client.folios?.length || 0} folio${(client.folios?.length || 0) === 1 ? '' : 's'}). Imported transactions are kept but will no longer be attributed to any RM until the folios are re-mapped. This cannot be undone.`,
                                confirmText: 'Delete',
                                variant: 'danger',
                              });
                              if (ok) deleteClient(client.id);
                            }}
                            className={`p-2 text-slate-400 hover:text-red-600 ${!isAdmin && 'hidden'}`}><Trash2 className="w-4 h-4" /></button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          )}

          {selectedClientIds.size > 0 && isAdmin && (
            <div className="p-4 bg-blue-600 border-t border-blue-700 flex flex-col md:flex-row items-center justify-between gap-4 animate-in slide-in-from-bottom-4">
              <div className="flex items-center text-white">
                <div className="bg-white/20 p-2 rounded-lg mr-3">
                  <UserPlus className="w-5 h-5" />
                </div>
                <div>
                  <div className="text-xs font-black uppercase tracking-widest lead-none">Bulk assignment</div>
                  <div className="text-[10px] font-bold opacity-80 uppercase">{selectedClientIds.size} clients selected</div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <select
                  value={bulkLevel ?? ''}
                  onChange={(e) => { setBulkLevel(e.target.value === '' ? null : Number(e.target.value)); setBulkUserId(''); }}
                  className="bg-white/10 border border-white/20 text-white text-[10px] font-black uppercase tracking-widest px-3 py-2 rounded-lg focus:ring-2 focus:ring-white outline-none"
                >
                  <option value="" className="text-slate-900">Select Level</option>
                  {[0, 1, 2, 3, 4, 5, 6].map(l => (
                    <option key={l} value={l} className="text-slate-900">Level {l} ({globalConfig.levelNames[l as keyof typeof globalConfig.levelNames]})</option>
                  ))}
                </select>

                <select
                  value={bulkUserId}
                  onChange={(e) => setBulkUserId(e.target.value)}
                  className="bg-white/10 border border-white/20 text-white text-[10px] font-black uppercase tracking-widest px-3 py-2 rounded-lg focus:ring-2 focus:ring-white outline-none min-w-[150px]"
                  disabled={bulkLevel === null}
                >
                  <option value="" className="text-slate-900">Select Manager</option>
                  {team.filter(t => t.level === bulkLevel || (Array.isArray(t.roles) && bulkLevel != null && t.roles.includes(bulkLevel))).map(u => (
                    <option key={u.id} value={u.id} className="text-slate-900">{u.name}{u.level !== bulkLevel ? ' • multi-role' : ''}</option>
                  ))}
                </select>

                <button
                  onClick={handleBulkMap}
                  disabled={bulkLevel === null || !bulkUserId}
                  className="bg-white text-blue-600 px-6 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest hover:bg-white/90 disabled:opacity-50 transition shadow-lg"
                >
                  Apply Mapping
                </button>

                <button
                  onClick={handleBulkDelete}
                  className="bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition shadow-lg flex items-center gap-1.5"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Delete Selected
                </button>

                <button
                  onClick={() => setSelectedClientIds(new Set())}
                  className="text-white/70 hover:text-white px-2 py-2 text-[10px] font-black uppercase tracking-widest"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          <Pagination
            currentPage={clientPage}
            totalItems={filteredClients.length}
            pageSize={pageSize}
            onPageChange={setClientPage}
          />
        </div>
      )}

      {activeTab === 'standardize' && isAdmin && (
        <div className="space-y-6 animate-in fade-in">
      {/* ── Manual merge panel ── */}
      {mergePanel && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => !mergeBusy && setMergePanel(null)}>
          <div className="bg-white dark:bg-slate-800 rounded-3xl w-full max-w-3xl max-h-[90vh] overflow-auto shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="px-8 py-6 border-b border-slate-100 dark:border-slate-700 flex justify-between items-center sticky top-0 bg-white dark:bg-slate-800">
              <div>
                <h3 className="font-black text-xl text-slate-900 dark:text-slate-100 tracking-tighter uppercase">Merge duplicate records</h3>
                <p className="text-xs text-slate-500 mt-1">PAN {mergePanel.pan} — {mergePanel.records.length} records</p>
              </div>
              <button onClick={() => setMergePanel(null)} disabled={mergeBusy} className="text-slate-400 hover:text-slate-700 disabled:opacity-40"><X className="w-5 h-5" /></button>
            </div>

            <div className="p-8 space-y-6">
              <div className="p-3 rounded-xl border border-amber-200 bg-amber-50 text-[11px] text-amber-800 font-medium">
                Merge only if these are the <strong>same person</strong>. A shared PAN can also mean a minor holding under a guardian&apos;s PAN — two different investors. Check the names and folios first.
              </div>

              <div>
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">1. Tick the records to merge, then pick the one to keep</label>
                <div className="space-y-2 mt-2">
                  {mergePanel.records.map(r => {
                    const st = mergeStats[r.id];
                    const picked = mergeMasterId === r.id;
                    const inc = mergeInclude.has(r.id);
                    return (
                      <label key={r.id} className={`flex items-start gap-3 p-4 rounded-2xl border-2 cursor-pointer transition ${!inc ? 'border-slate-100 dark:border-slate-700 opacity-45' : picked ? 'border-blue-600 bg-blue-50 dark:bg-blue-900/20' : 'border-slate-200 dark:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-700/40'}`}>
                        <input type="checkbox" className="mt-1" checked={inc}
                          onClick={e => e.stopPropagation()}
                          onChange={e => {
                            const next = new Set(mergeInclude);
                            if (e.target.checked) next.add(r.id); else { next.delete(r.id); if (mergeMasterId === r.id) setMergeMasterId(''); }
                            setMergeInclude(next);
                          }} />
                        <input type="radio" name="mergeMaster" className="mt-1" checked={picked} disabled={!inc}
                          onChange={() => { setMergeMasterId(r.id); setMergeRmId(ownerOfClient(r)?.id || ''); }} />
                        <div className="flex-1 min-w-0">
                          <div className="font-black text-sm text-slate-900 dark:text-slate-100">{r.name}</div>
                          <div className="text-[11px] text-slate-500 mt-1 flex flex-wrap gap-x-4 gap-y-1">
                            <span>RM: <strong>{st?.rm || ownerOfClient(r)?.name || 'none'}</strong></span>
                            <span>{r.folios?.length || 0} folios</span>
                            <span>{st ? `${st.txCount} transactions` : '…'}</span>
                            <span>{st ? `₹${st.gross}` : ''}</span>
                          </div>
                          <div className="text-[9px] text-slate-400 font-mono mt-1 truncate">{r.id}</div>
                        </div>
                        {!inc ? <span className="text-[9px] font-black uppercase tracking-widest text-slate-500 bg-slate-100 px-2 py-1 rounded-full whitespace-nowrap">Leave alone</span>
                          : picked ? <span className="text-[9px] font-black uppercase tracking-widest text-blue-700 bg-blue-100 px-2 py-1 rounded-full whitespace-nowrap">Keep this</span>
                          : <span className="text-[9px] font-black uppercase tracking-widest text-red-700 bg-red-100 px-2 py-1 rounded-full whitespace-nowrap">Merge in</span>}
                      </label>
                    );
                  })}
                </div>
                <p className="text-[10px] text-slate-400 mt-2">Untick anything that is a <strong>different investor</strong> — it stays exactly as it is. Ticked records other than the one you keep are deleted, and their transactions move to the kept record.</p>
              </div>

              <div>
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">2. Who should own the merged client?</label>
                <select value={mergeRmId} onChange={e => setMergeRmId(e.target.value)}
                  className="w-full border border-slate-200 dark:border-slate-600 p-4 rounded-2xl mt-2 font-bold bg-white dark:bg-slate-900 outline-none text-sm">
                  <option value="">— leave as it is on the kept record —</option>
                  {team.slice().sort((a, b) => a.level - b.level || a.name.localeCompare(b.name))
                    .map(t => <option key={t.id} value={t.id}>{t.name} — L{t.level}</option>)}
                </select>
                <p className="text-[10px] text-slate-400 mt-2">
                  These records sit under different RMs, so the merge decides whose book this investor lands in. Choose deliberately — the whole history moves with it.
                </p>
              </div>

              {(() => {
                const dupes = mergePanel.records.filter(r => r.id !== mergeMasterId && mergeInclude.has(r.id));
                const left = mergePanel.records.filter(r => !mergeInclude.has(r.id)).length;
                const tx = dupes.reduce((s, r) => s + (mergeStats[r.id]?.txCount || 0), 0);
                const gr = dupes.reduce((s, r) => s + (mergeStats[r.id]?.gross || 0), 0);
                return (
                  <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-900/40 border border-slate-200 dark:border-slate-700 text-[11px] text-slate-600 dark:text-slate-300">
                    <strong>{dupes.length}</strong> record(s) deleted · <strong>{tx}</strong> transaction(s) worth <strong>₹{gr.toFixed(2)}</strong> move to the kept record{left > 0 ? <> · <strong>{left}</strong> record(s) left untouched</> : null} · payouts recalculate afterwards.
                  </div>
                );
              })()}
            </div>

            <div className="px-8 py-6 bg-slate-50 dark:bg-slate-900/40 border-t border-slate-100 dark:border-slate-700 flex justify-end gap-3 sticky bottom-0">
              <button onClick={() => setMergePanel(null)} disabled={mergeBusy}
                className="px-6 py-3 rounded-2xl border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 text-xs font-black uppercase tracking-widest disabled:opacity-40">Cancel</button>
              <button onClick={runMerge} disabled={mergeBusy || !mergeMasterId}
                className="px-8 py-3 rounded-2xl bg-red-600 text-white text-xs font-black uppercase tracking-widest hover:bg-red-700 disabled:opacity-40 shadow-lg shadow-red-100">
                {mergeBusy ? 'Working…' : 'Merge records'}
              </button>
            </div>
          </div>
        </div>
      )}

          <div className="bg-white dark:bg-slate-800 p-6 rounded-xl border border-slate-200 shadow-sm">
            <h3 className="text-lg font-bold text-slate-900 mb-4 flex items-center"><Search className="w-5 h-5 mr-2 text-indigo-600" /> Advanced Duplicate Detection</h3>
            <p className="text-sm text-slate-500 mb-2 font-medium">Scanning for conflicts in Identity (PAN), Contact (Mobile/Email), and exact Name matches.</p>
            <div className="mb-6 p-3 rounded-xl border border-amber-200 bg-amber-50 text-[11px] text-amber-800 font-medium">
              <strong>Check the names before merging.</strong> A shared PAN does not always mean a duplicate — a minor invests under the guardian's PAN, so siblings legitimately share one (e.g. two children of the same parent). Merge only when the records are the SAME person; “Keep as Master” permanently folds the others into it.
            </div>

            <div className="space-y-6 text-slate-900 dark:text-slate-100">
              {duplicateGroups.map((res, gIdx) => (
                <div key={`${res.type}-${gIdx}`} className="p-5 border border-amber-100 bg-amber-50/20 rounded-2xl space-y-4">
                  <div className="flex justify-between items-center">
                    <div>
                      <span className="text-[10px] font-black text-amber-600 uppercase tracking-widest block mb-1">Possible duplicate — matched by {res.type}</span>
                      <span className="text-sm font-black text-slate-900">{res.value}</span>
                    </div>
                    <span className="text-[10px] bg-amber-100 text-amber-700 px-3 py-1 rounded-full font-black uppercase tracking-tight">{res.group.length} Conflicting Records</span>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {res.group.map(c => (
                      <div key={c.id} className="bg-white dark:bg-slate-800 p-4 rounded-xl border border-slate-100 flex flex-col justify-between shadow-sm relative overflow-hidden group">
                        <div className="absolute top-0 right-0 p-2 opacity-0 group-hover:opacity-100 transition">
                          <button onClick={() => openClientModal(c)} className="text-blue-600 hover:text-blue-800"><Edit2 size={12} /></button>
                        </div>
                        <div className="mb-4">
                          <div className="font-black text-slate-900 text-sm mb-1">{c.name}</div>
                          <div className="flex flex-wrap gap-2">
                            <span className="text-[9px] font-black text-slate-400 uppercase tracking-tighter flex items-center bg-slate-50 px-2 py-0.5 rounded border border-slate-100"><Shield size={10} className="mr-1" /> {c.pan}</span>
                            {c.mobile && <span className="text-[9px] font-black text-slate-400 uppercase tracking-tighter flex items-center bg-slate-50 px-2 py-0.5 rounded border border-slate-100"><Phone size={10} className="mr-1" /> {c.mobile}</span>}
                            {c.email && <span className="text-[9px] font-black text-slate-400 uppercase tracking-tighter flex items-center bg-slate-50 px-2 py-0.5 rounded border border-slate-100"><Mail size={10} className="mr-1" /> {c.email}</span>}
                          </div>
                        </div>
                        <div className="pt-3 border-t border-slate-50 flex gap-2">
                          <button
                            onClick={() => handleMergeClients(c.id, res.group.filter(other => other.id !== c.id).map(other => other.id))}
                            className="flex-1 bg-blue-600 text-white py-2 rounded-lg text-[10px] font-black uppercase tracking-widest hover:bg-blue-700 shadow-md shadow-blue-50 transition"
                          >
                            Keep as Master
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {duplicateGroups.length === 0 && (
                <div className="text-center py-16 bg-slate-50 rounded-2xl border-2 border-dashed border-slate-200">
                  <Check className="w-12 h-12 mx-auto mb-3 text-emerald-500 opacity-40" />
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Database Identity Integrity Verified</p>
                  <p className="text-xs text-slate-400 mt-1">No duplicates detected across managed vectors.</p>
                </div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="bg-white dark:bg-slate-800 p-6 rounded-xl border border-slate-200 shadow-sm">
              <h3 className="text-sm font-black uppercase tracking-widest text-slate-900 mb-4 flex items-center"><Tags className="w-4 h-4 mr-2 text-blue-600" /> AMC Name Standardization</h3>
              <div className="max-h-[300px] overflow-auto border rounded-lg">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 sticky top-0 border-b">
                    <tr><th className="px-4 py-2 text-left">Original Name</th><th className="px-4 py-2 text-left">Mapped Standard</th></tr>
                  </thead>
                  <tbody className="divide-y">
                    {amcMappings.slice((amcPage - 1) * pageSize, amcPage * pageSize).map((m, i) => (
                      <tr key={i} className="hover:bg-slate-50">
                        <td className="px-4 py-2 text-slate-500 truncate max-w-[150px]">{m.original}</td>
                        <td className="px-4 py-2 text-blue-600 font-bold">{m.standard}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination
                currentPage={amcPage}
                totalItems={amcMappings.length}
                pageSize={pageSize}
                onPageChange={setAmcPage}
              />
            </div>
            <div className="bg-white dark:bg-slate-800 p-6 rounded-xl border border-slate-200 shadow-sm">
              <h3 className="text-sm font-black uppercase tracking-widest text-slate-900 mb-4 flex items-center"><Database className="w-4 h-4 mr-2 text-indigo-600" /> Scheme Standardization</h3>
              <div className="max-h-[300px] overflow-auto border rounded-lg">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 sticky top-0 border-b">
                    <tr><th className="px-4 py-2 text-left">Extracted Name</th><th className="px-4 py-2 text-left">Standard Name</th></tr>
                  </thead>
                  <tbody className="divide-y">
                    {schemeMappings.slice((schemePage - 1) * pageSize, schemePage * pageSize).map((m, i) => (
                      <tr key={i} className="hover:bg-slate-50">
                        <td className="px-4 py-2 text-slate-500 truncate max-w-[150px]">{m.original}</td>
                        <td className="px-4 py-2 text-indigo-600 font-bold">{m.standard}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination
                currentPage={schemePage}
                totalItems={schemeMappings.length}
                pageSize={pageSize}
                onPageChange={setSchemePage}
              />
            </div>
          </div>
        </div>
      )}

      {/* Mapping Modal */}
      {isAdmin && isMappingModalOpen && selectedClientForMapping && mappingForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-md p-4 animate-in fade-in">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl overflow-hidden animate-in zoom-in-95">
            <div className="px-8 py-6 border-b border-slate-100 flex justify-between items-center bg-white">
              <div className="flex flex-col">
                <h3 className="font-black text-xl text-slate-900 tracking-tighter uppercase">{selectedClientForMapping.name}</h3>
                <p className="text-xs text-blue-600 font-bold uppercase tracking-widest">Hierarchy Mapping</p>
              </div>
              <button onClick={() => setIsMappingModalOpen(false)} className="p-2 hover:bg-slate-100 rounded-full"><X className="w-6 h-6 text-slate-400" /></button>
            </div>
            <div className="p-8 grid grid-cols-1 md:grid-cols-2 gap-6 bg-slate-50/50 max-h-[60vh] overflow-y-auto">
              {[0, 1, 2, 3, 4, 5, 6].map((level) => (
                <div key={level} className="bg-white dark:bg-slate-800 p-5 rounded-2xl border border-slate-200 shadow-sm">
                  <label className="block text-[10px] font-black uppercase text-slate-400 mb-3 tracking-widest">L{level} - {globalConfig.levelNames[level as keyof typeof globalConfig.levelNames]}</label>
                  <select
                    value={mappingForm[`level${level}Id` as keyof typeof mappingForm] || ''}
                    onChange={(e) => setMappingForm({ ...mappingForm, [`level${level}Id`]: e.target.value } as any)}
                    className="w-full border border-slate-200 rounded-xl text-sm px-4 py-3 font-bold text-slate-700 bg-slate-50/50 outline-none"
                  >
                    <option value="">-- No Assignment --</option>
                    {/* Always include the CURRENTLY-ASSIGNED user, even if their
                        profile level ≠ this slot. Otherwise a user placed here
                        whose profile level differs (e.g. Shakeel Khan Mansuri is a
                        profile-L2 user sitting at the L3/Sherpa slot as an RM) is
                        filtered out, and the slot falsely renders "No Assignment"
                        while level{n}Id is actually set — misleading and risks a
                        silent wipe on save. The "• multi-role" tag flags the case. */}
                    {team.filter(t => t.level === level
                        || (Array.isArray(t.roles) && t.roles.includes(level))
                        || t.id === mappingForm[`level${level}Id` as keyof typeof mappingForm]
                      ).map(u => (
                      <option key={u.id} value={u.id}>{u.name} ({u.code}){u.level !== level ? ' • multi-role' : ''}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
            <div className="px-8 py-5 bg-white border-t border-slate-100">
              <label className="block text-[10px] font-black uppercase text-slate-400 mb-2 tracking-widest">Lead Source — who referred this client?</label>
              <select
                value={mappingLeadSource}
                onChange={(e) => setMappingLeadSource(e.target.value === '' ? '' : Number(e.target.value))}
                className="w-full border border-slate-200 rounded-xl text-sm px-4 py-3 font-bold text-slate-700 bg-slate-50/50 outline-none"
              >
                <option value="">Self-sourced (default — normal split)</option>
                {[1, 2, 3, 4, 5, 6, 7].map(l => {
                  const uid = (mappingForm as any)[`level${l}Id`];
                  if (!uid) return null;
                  const u = team.find(t => t.id === uid);
                  return <option key={l} value={l}>L{l} — {u ? `${u.name} (${u.code})` : 'assigned'}</option>;
                })}
              </select>
              <p className="text-[10px] text-slate-400 mt-2">Picks the Lead-Source Sharing Matrix row (Settings → Lead Source). Leave as Self-sourced to keep the normal owner-driven split.</p>
            </div>
            <div className="px-8 py-6 bg-white border-t border-slate-100 flex justify-end space-x-3">
              <div className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  id="recalc-mapping"
                  checked={applyToHistorical}
                  onChange={(e) => setApplyToHistorical(e.target.checked)}
                  className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 w-4 h-4"
                />
                <label htmlFor="recalc-mapping" className="text-[10px] font-black uppercase text-slate-500 cursor-pointer">Recalculate historical payouts</label>
              </div>
              <button onClick={() => setIsMappingModalOpen(false)} className="px-6 py-3 text-sm font-black uppercase tracking-widest text-slate-400 hover:text-slate-600">Cancel</button>
              <button onClick={saveMapping} className="px-10 py-3 bg-blue-600 text-white rounded-2xl text-xs font-black uppercase tracking-widest hover:bg-blue-700 shadow-xl shadow-blue-100 transition">Save Mapping</button>
            </div>
          </div>
        </div>
      )}

      {/* Team Modal (Admin Only) */}
      {isAdmin && isTeamModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-md p-4 animate-in fade-in">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl overflow-hidden animate-in zoom-in-95 h-[90vh] flex flex-col">
            <div className="px-8 py-6 border-b border-slate-100 bg-white flex justify-between items-center">
              <h3 className="font-black text-xl text-slate-900 tracking-tighter uppercase">{editingMember ? 'Edit User Account' : 'Provision User'}</h3>
              <button onClick={() => setIsTeamModalOpen(false)} className="p-2 hover:bg-slate-100 rounded-full transition"><X className="w-6 h-6 text-slate-400" /></button>
            </div>
            <div className="p-8 space-y-8 bg-slate-50/50 max-h-[70vh] overflow-y-auto overflow-x-hidden">
              <section className="space-y-4">
                <div className="flex items-center space-x-2 pb-2 border-b border-slate-100">
                  <UserPlus className="w-4 h-4 text-blue-600" />
                  <h4 className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-900">Basic Information</h4>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Full Name</label>
                  <input type="text" value={memberForm.name} onChange={e => setMemberForm({ ...memberForm, name: e.target.value })} className="w-full border border-slate-200 p-4 rounded-2xl mt-1.5 font-bold outline-none bg-white" placeholder="John Doe" />
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Access Email</label>
                  <input type="email" value={memberForm.email} onChange={e => setMemberForm({ ...memberForm, email: e.target.value })} className="w-full border border-slate-200 p-4 rounded-2xl mt-1.5 font-bold outline-none bg-white" placeholder="john@wealthflow.com" />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Employee/ARN Code</label>
                    <input type="text" value={memberForm.code} onChange={e => setMemberForm({ ...memberForm, code: e.target.value })} className="w-full border border-slate-200 p-4 rounded-2xl mt-1.5 font-bold outline-none bg-white" placeholder="WF-001" />
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">GST Number (Optional)</label>
                    <input type="text" value={memberForm.gstNumber} onChange={e => setMemberForm({ ...memberForm, gstNumber: e.target.value.toUpperCase() })} className="w-full border border-slate-200 p-4 rounded-2xl mt-1.5 font-bold outline-none bg-white uppercase" placeholder="22AAAAA0000A1Z5" />
                  </div>
                </div>
              </section>

              <section className="space-y-4">
                <div className="flex items-center space-x-2 pb-2 border-b border-slate-100">
                  <Shield className="w-4 h-4 text-blue-600" />
                  <h4 className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-900">Hierarchy & Sharing</h4>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Reports To (Parent)</label>
                    <select
                      value={memberForm.parentId || ''}
                      onChange={e => setMemberForm({ ...memberForm, parentId: e.target.value })}
                      className="w-full border border-slate-200 p-4 rounded-2xl mt-1.5 font-bold bg-white outline-none"
                    >
                      <option value="">-- No Parent (Root) --</option>
                      {team
                        .filter(t => t.id !== editingMember?.id && t.level > (memberForm.level || 0))
                        .sort((a, b) => b.level - a.level)
                        .map(t => (
                          <option key={t.id} value={t.id}>L{t.level} - {t.name}</option>
                        ))
                      }
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Sharing % Rate</label>
                    <div className="relative">
                      <input
                        type="number"
                        value={memberForm.sharingRate}
                        onChange={e => setMemberForm({ ...memberForm, sharingRate: e.target.value })}
                        className="w-full border border-slate-200 p-4 rounded-2xl mt-1.5 font-bold outline-none bg-white"
                        placeholder="0"
                      />
                      <span className="absolute right-4 top-1/2 -translate-y-1 font-bold text-slate-400 font-mono">%</span>
                    </div>
                    {editingMember && (
                      <div className="mt-2">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Apply this rate / level from</label>
                        <select
                          value={memberForm.rateEffectiveFrom ?? thisMonth}
                          onChange={e => setMemberForm({ ...memberForm, rateEffectiveFrom: e.target.value })}
                          className="w-full border border-slate-200 p-3 rounded-2xl mt-1.5 font-bold bg-white outline-none text-xs"
                        >
                          <option value="0000-01">All months — including past payouts</option>
                          {effectiveMonthOptions.map(m => (
                            <option key={m.value} value={m.value}>{m.label} onward</option>
                          ))}
                        </select>
                        <p className="text-[10px] text-slate-400 mt-1">
                          {(memberForm.rateEffectiveFrom ?? thisMonth) === "0000-01"
                            ? "Every month will be recalculated at this rate, including months already reported or invoiced."
                            : `Months before ${memberForm.rateEffectiveFrom ?? thisMonth} keep the rate that applied then. Locked periods never change.`}
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Role</label>
                    <select
                      value={memberForm.role || Role.OPS}
                      onChange={e => {
                        const newRole = e.target.value as Role;
                        // Auto-set sensible default level: ADMIN/FINANCE at L7, others keep current
                        setMemberForm(prev => ({
                          ...prev,
                          role: newRole,
                          level: (newRole === Role.ADMIN || newRole === Role.FINANCE) ? 7 : (prev.level ?? 6),
                        }));
                      }}
                      className="w-full border border-slate-200 p-4 rounded-2xl mt-1.5 font-bold bg-white outline-none"
                    >
                      <option value={Role.ADMIN}>Admin — full access</option>
                      <option value={Role.FINANCE}>Finance — release payments</option>
                      <option value={Role.OPS}>Ops / RM — own clients only</option>
                      <option value={Role.VIEWER}>Viewer — read-only</option>
                    </select>
                    {memberForm.role === Role.FINANCE && (
                      <p className="text-[10px] text-emerald-700 dark:text-emerald-400 mt-1 font-medium">
                        ✓ Can settle approved invoices, view audit log, see all clients (read-only)
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">System Level (Primary)</label>
                    <select value={memberForm.level} onChange={e => setMemberForm({ ...memberForm, level: Number(e.target.value) })} className="w-full border border-slate-200 p-4 rounded-2xl mt-1.5 font-bold bg-white outline-none">
                      {[7, 6, 5, 4, 3, 2, 1].map(l => <option key={l} value={l}>Level {l}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Account Password</label>
                    <input type="password" value={memberForm.password || ''} onChange={e => setMemberForm({ ...memberForm, password: e.target.value })} className="w-full border border-slate-200 p-4 rounded-2xl mt-1.5 font-bold outline-none bg-white" placeholder={editingMember ? 'Leave blank to keep current password' : 'Set a password'} />
                  {editingMember && <p className="text-[10px] text-slate-400 mt-1">Existing passwords are stored encrypted and can never be displayed. Leave this blank unless you want to change it.</p>}
                  </div>
                </div>

                {/* Multi-role: extra levels this user may be assigned to across clients */}
                <div className="mt-2 bg-slate-50 dark:bg-slate-900/30 border border-slate-200 dark:border-slate-700 rounded-2xl p-4">
                  <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Additional Levels (Multi-Role)</label>
                  <p className="text-[11px] text-slate-500 mt-1 mb-3">Tick every level this user can be assigned to in client hierarchies. On each client they earn that level's share. The Primary level above is always allowed.</p>
                  <div className="flex flex-wrap gap-2">
                    {[1,2,3,4,5,6,7].map(l => {
                      const isPrimary = (memberForm.level ?? 6) === l;
                      const checked = isPrimary || (memberForm.roles || []).includes(l);
                      return (
                        <button
                          type="button"
                          key={l}
                          disabled={isPrimary}
                          onClick={() => {
                            const cur = new Set(memberForm.roles || []);
                            if (cur.has(l)) cur.delete(l); else cur.add(l);
                            setMemberForm({ ...memberForm, roles: Array.from(cur).filter(x => x !== (memberForm.level ?? 6)) });
                          }}
                          className={`px-3 py-2 rounded-xl text-xs font-black border-2 transition ${checked ? 'border-blue-600 bg-blue-600 text-white' : 'border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-100'} ${isPrimary ? 'opacity-70 cursor-not-allowed' : ''}`}
                        >
                          L{l}{isPrimary ? ' ★' : ''}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </section>

              <section className="space-y-4">
                <div className="flex items-center space-x-2 pb-2 border-b border-slate-100">
                  <Check className="w-4 h-4 text-blue-600" />
                  <h4 className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-900">Bank Details</h4>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Account Holder Name</label>
                  <input type="text" value={memberForm.bankDetails?.accountName} onChange={e => setMemberForm({ ...memberForm, bankDetails: { ...memberForm.bankDetails!, accountName: e.target.value } })} className="w-full border border-slate-200 p-4 rounded-2xl mt-1.5 font-bold outline-none bg-white" placeholder="Same as Full Name" />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Bank Name</label>
                    <input type="text" value={memberForm.bankDetails?.bankName} onChange={e => setMemberForm({ ...memberForm, bankDetails: { ...memberForm.bankDetails!, bankName: e.target.value } })} className="w-full border border-slate-200 p-4 rounded-2xl mt-1.5 font-bold outline-none bg-white" placeholder="HDFC Bank" />
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Branch Name</label>
                    <input type="text" value={memberForm.bankDetails?.branch} onChange={e => setMemberForm({ ...memberForm, bankDetails: { ...memberForm.bankDetails!, branch: e.target.value } })} className="w-full border border-slate-200 p-4 rounded-2xl mt-1.5 font-bold outline-none bg-white" placeholder="Main Branch" />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Account Number</label>
                    <input type="text" value={memberForm.bankDetails?.accountNumber} onChange={e => setMemberForm({ ...memberForm, bankDetails: { ...memberForm.bankDetails!, accountNumber: e.target.value } })} className="w-full border border-slate-200 p-4 rounded-2xl mt-1.5 font-bold outline-none bg-white font-mono" placeholder="00018239..." />
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">IFSC Code</label>
                    <input type="text" value={memberForm.bankDetails?.ifscCode} onChange={e => setMemberForm({ ...memberForm, bankDetails: { ...memberForm.bankDetails!, ifscCode: e.target.value.toUpperCase() } })} className="w-full border border-slate-200 p-4 rounded-2xl mt-1.5 font-bold outline-none bg-white font-mono uppercase" placeholder="HDFC0000001" />
                  </div>
                </div>
              </section>

              <section className="space-y-4">
                <div className="flex items-center space-x-2 pb-2 border-b border-slate-100">
                  <Tags className="w-4 h-4 text-blue-600" />
                  <h4 className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-900">Office Address</h4>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Street / Building</label>
                  <input type="text" value={memberForm.address?.street} onChange={e => setMemberForm({ ...memberForm, address: { ...memberForm.address!, street: e.target.value } })} className="w-full border border-slate-200 p-4 rounded-2xl mt-1.5 font-bold outline-none bg-white" placeholder="Plot No 4, Skyline" />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">City</label>
                    <input type="text" value={memberForm.address?.city} onChange={e => setMemberForm({ ...memberForm, address: { ...memberForm.address!, city: e.target.value } })} className="w-full border border-slate-200 p-4 rounded-2xl mt-1.5 font-bold outline-none bg-white" placeholder="Mumbai" />
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">State</label>
                    <input type="text" value={memberForm.address?.state} onChange={e => setMemberForm({ ...memberForm, address: { ...memberForm.address!, state: e.target.value } })} className="w-full border border-slate-200 p-4 rounded-2xl mt-1.5 font-bold outline-none bg-white" placeholder="Maharashtra" />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Pincode</label>
                    <input type="text" value={memberForm.address?.pincode} onChange={e => setMemberForm({ ...memberForm, address: { ...memberForm.address!, pincode: e.target.value } })} className="w-full border border-slate-200 p-4 rounded-2xl mt-1.5 font-bold outline-none bg-white font-mono" placeholder="400001" />
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Country</label>
                    <input type="text" value={memberForm.address?.country} onChange={e => setMemberForm({ ...memberForm, address: { ...memberForm.address!, country: e.target.value } })} className="w-full border border-slate-200 p-4 rounded-2xl mt-1.5 font-bold outline-none bg-white" placeholder="India" />
                  </div>
                </div>
              </section>
            </div>
            <div className="px-8 py-6 bg-white border-t border-slate-100 flex items-center justify-between gap-3">
              <p className="text-[10px] font-bold text-slate-400 max-w-[40%] leading-tight">
                Changed the sharing %? Use <span className="text-blue-600 font-black">Save &amp; Recalculate</span> to apply it across every payout. “Save” alone stores it without recomputing past payouts.
              </p>
              <div className="flex space-x-3">
                <button onClick={() => setIsTeamModalOpen(false)} className="px-6 py-3 text-xs font-black uppercase text-slate-400 hover:text-slate-600">Cancel</button>
                <button onClick={() => saveTeamMember(false)} className="px-6 py-3 text-xs font-black uppercase tracking-widest text-blue-700 bg-blue-50 rounded-2xl hover:bg-blue-100 transition">Save</button>
                <button onClick={() => saveTeamMember(true)} className="px-8 py-3 bg-blue-600 text-white rounded-2xl text-xs font-black uppercase tracking-widest hover:bg-blue-700 shadow-xl shadow-blue-100 transition">Save &amp; Recalculate</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Client Modal (Admin Only) */}
      {isAdmin && isClientModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-md p-4 animate-in fade-in">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg overflow-hidden animate-in zoom-in-95">
            <div className="px-8 py-6 border-b border-slate-100 bg-white flex justify-between items-center">
              <h3 className="font-black text-xl text-slate-900 tracking-tighter uppercase">{editingClient ? 'Edit Investor' : 'New Investor Profile'}</h3>
              <button onClick={() => setIsClientModalOpen(false)} className="p-2 hover:bg-slate-100 rounded-full transition"><X className="w-6 h-6 text-slate-400" /></button>
            </div>
            <div className="p-8 space-y-4 bg-slate-50/50">
              <div>
                <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Investor Name</label>
                <input type="text" value={clientForm.name} onChange={e => setClientForm({ ...clientForm, name: e.target.value })} className="w-full border border-slate-200 p-4 rounded-2xl mt-1.5 font-bold outline-none" />
              </div>
              <div>
                <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">PAN Number</label>
                <input
                  type="text"
                  value={clientForm.pan}
                  onChange={e => setClientForm({ ...clientForm, pan: e.target.value.toUpperCase() })}
                  className={`w-full border p-4 rounded-2xl mt-1.5 font-bold outline-none uppercase ${clientForm.pan && !isValidPAN(clientForm.pan) ? 'border-red-400' : 'border-slate-200'}`}
                  placeholder="ABCDE1234F"
                />
                {clientForm.pan && !isValidPAN(clientForm.pan) && (
                  <p className="text-red-500 text-xs mt-1">Invalid PAN format (e.g. ABCDE1234F)</p>
                )}
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Email ID</label>
                  <input type="email" value={clientForm.email} onChange={e => setClientForm({ ...clientForm, email: e.target.value })} className="w-full border border-slate-200 p-4 rounded-2xl mt-1.5 font-bold outline-none" placeholder="client@example.com" />
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Mobile Number</label>
                  <input type="text" value={clientForm.mobile} onChange={e => setClientForm({ ...clientForm, mobile: e.target.value })} className="w-full border border-slate-200 p-4 rounded-2xl mt-1.5 font-bold outline-none" placeholder="+91 98765 43210" />
                </div>
              </div>
              <div>
                <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Linked Folios (Comma separated)</label>
                <textarea
                  value={folioText}
                  onChange={e => {
                    setFolioText(e.target.value);
                    // Keep the model in step on every keystroke so Save works
                    // even if the box never loses focus — but display the raw
                    // text, so commas and spaces stay where they were typed.
                    setClientForm({ ...clientForm, folios: parseFolios(e.target.value) });
                  }}
                  onBlur={() => setFolioText(parseFolios(folioText).join(', '))}
                  className="w-full border border-slate-200 p-4 rounded-2xl mt-1.5 font-bold outline-none min-h-[100px]"
                  placeholder="11366282/49, 45966856/64"
                />
                <div className="text-[10px] font-bold text-slate-400 mt-1.5">
                  {parseFolios(folioText).length} folio{parseFolios(folioText).length === 1 ? '' : 's'} — separate each with a comma
                </div>
              </div>
            </div>
            <div className="px-8 py-6 bg-white border-t border-slate-100 flex justify-end space-x-3">
              <button onClick={() => setIsClientModalOpen(false)} className="px-6 py-3 text-xs font-black uppercase text-slate-400 hover:text-slate-600">Cancel</button>
              <button onClick={saveClient} className="px-10 py-3 bg-blue-600 text-white rounded-2xl text-xs font-black uppercase tracking-widest shadow-xl shadow-blue-100 hover:bg-blue-700 transition">Save Profile</button>
            </div>
          </div>
        </div>
      )}

      {/* User's Mapped Clients List Modal */}
      {isAdmin && isUserClientsModalOpen && selectedUserForClientList && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-md p-4 animate-in fade-in">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl overflow-hidden animate-in zoom-in-95">
            <div className="px-8 py-6 border-b border-slate-100 flex justify-between items-center bg-white">
              <div className="flex flex-col">
                <h3 className="font-black text-xl text-slate-900 tracking-tighter uppercase">Mapped Clients List</h3>
                <p className="text-xs text-blue-600 font-bold uppercase tracking-widest">{selectedUserForClientList.name} (L{selectedUserForClientList.level})</p>
              </div>
              <button onClick={() => setIsUserClientsModalOpen(false)} className="p-2 hover:bg-slate-100 rounded-full"><X className="w-6 h-6 text-slate-400" /></button>
            </div>

            <div className="max-h-[60vh] overflow-y-auto">
              {clients.filter(c => {
                        // Same primary-owner rule as the count outside —
                        // user owns this client iff they're at the LOWEST
                        // assigned level. Keeps count and modal in sync.
                        if (!c.hierarchy) return false;
                        for (let l = 1; l <= 7; l++) {
                          const uid = c.hierarchy[`level${l}Id` as keyof typeof c.hierarchy];
                          if (!uid) continue;
                          return uid === selectedUserForClientList.id;
                        }
                        return false;
                      }).length === 0 ? (
                <div className="p-20 text-center text-slate-400 font-bold uppercase tracking-widest text-[10px]">No clients mapped to this account</div>
              ) : (
                <>
                  <table className="w-full text-sm text-left">
                    <thead className="bg-slate-50 text-slate-400 font-black border-b border-slate-200 uppercase tracking-widest text-[9px] sticky top-0">
                      <tr>
                        <th className="px-6 py-3">Investor Name</th>
                        <th className="px-6 py-3">PAN</th>
                        <th className="px-6 py-3 text-right">Change Mapping</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-700/50">
                      {clients
                        .filter(c => c.hierarchy[`level${selectedUserForClientList.level}Id` as keyof typeof c.hierarchy] === selectedUserForClientList.id)
                        .slice((modalClientPage - 1) * pageSize, modalClientPage * pageSize)
                        .map(client => (
                          <tr key={client.id} className="hover:bg-slate-50">
                            <td className="px-6 py-4 font-bold text-slate-900">{client.name}</td>
                            <td className="px-6 py-4 text-xs font-medium text-slate-500">{client.pan}</td>
                            <td className="px-6 py-4 text-right">
                              <div className="flex items-center justify-end gap-2">
                                <select
                                  className="text-[10px] font-bold border border-slate-200 rounded-lg px-2 py-1 outline-none bg-white focus:ring-2 focus:ring-blue-100"
                                  value={selectedUserForClientList.id}
                                  onChange={(e) => handleQuickReassign(client.id, selectedUserForClientList.level, e.target.value)}
                                >
                                  <option value="">-- Unassign --</option>
                                  {team.filter(t => t.level === selectedUserForClientList.level || (Array.isArray(t.roles) && t.roles.includes(selectedUserForClientList.level))).map(t => (
                                    <option key={t.id} value={t.id}>{t.name}{t.level !== selectedUserForClientList.level ? ' • multi-role' : ''}</option>
                                  ))}
                                </select>
                                <button
                                  onClick={() => {
                                    setIsUserClientsModalOpen(false);
                                    openMappingModal(client);
                                  }}
                                  className="p-1.5 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors shadow-sm border border-blue-100"
                                  title="Full Hierarchy Mapping"
                                >
                                  <UserCheck size={14} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))
                      }
                    </tbody>
                  </table>
                  <Pagination
                    currentPage={modalClientPage}
                    totalItems={clients.filter(c => {
                        // Same primary-owner rule as the count outside —
                        // user owns this client iff they're at the LOWEST
                        // assigned level. Keeps count and modal in sync.
                        if (!c.hierarchy) return false;
                        for (let l = 1; l <= 7; l++) {
                          const uid = c.hierarchy[`level${l}Id` as keyof typeof c.hierarchy];
                          if (!uid) continue;
                          return uid === selectedUserForClientList.id;
                        }
                        return false;
                      }).length}
                    pageSize={pageSize}
                    onPageChange={setModalClientPage}
                  />
                </>
              )}
            </div>

            <div className="px-8 py-6 bg-white border-t border-slate-100 flex justify-end">
              <button onClick={() => setIsUserClientsModalOpen(false)} className="px-10 py-3 bg-slate-900 text-white rounded-2xl text-xs font-black uppercase tracking-widest hover:bg-slate-800 shadow-xl shadow-slate-200 transition">Close List</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
