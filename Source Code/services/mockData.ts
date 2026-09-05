
import { Client, ImportBatch, SharingConfig, TeamMember, BrokerageTransaction, Role, PayoutInvoice, TransactionStatus, TransactionSource } from '../types';

export const MOCK_TEAM: TeamMember[] = [
  { 
    id: 'admin_root', 
    name: 'System Administrator', 
    code: 'ADMIN-001', 
    role: Role.ADMIN,
    level: 7,
    email: 'admin@wealthflow.com',
    password: 'admin', 
    bankDetails: { accountName: 'WealthFlow Corp', accountNumber: '9988776655', bankName: 'HDFC Bank', ifscCode: 'HDFC0001234' }
  },
  {
    id: 'tm_17001',
    name: 'Rajesh Kumar',
    code: 'EMP-101',
    role: Role.OPS,
    level: 6,
    email: 'rajesh@wealthflow.com',
    password: 'user123',
    bankDetails: { accountName: 'Rajesh Kumar', accountNumber: '1122334455', bankName: 'ICICI Bank', ifscCode: 'ICIC0001111' }
  }
];

export const GLOBAL_CONFIG: SharingConfig = {
  id: 'global_config',
  name: 'Standard Payout Rules',
  companyExpensePct: 15,
  levels: {
    7: 20,
    6: 15,
    5: 15,
    4: 15,
    3: 15,
    2: 15,
    1: 5,
  },
  levelNames: {
    7: 'Super Holding',
    6: 'Corporate House',
    5: 'Partner Level 2',
    4: 'Regional Level 3',
    3: 'Zonal Level 4',
    2: 'Manager Level 5',
    1: 'Relationship Manager (L1)',
  },
  scope: 'GLOBAL'
};

export const MOCK_CLIENTS: Client[] = [
    {
        id: 'c_001',
        name: 'Aditya Birla Capital',
        pan: 'ABCDE1234F',
        folios: ['12345678/12', '98765432/11'],
        hierarchy: {
            level1Id: 'tm_17001', level2Id: '', level3Id: '', level4Id: '', level5Id: '', level6Id: 'admin_root', level7Id: ''
        }
    },
    {
        id: 'c_002',
        name: 'Reliance Industries Trust',
        pan: 'RILT9988X',
        folios: ['10101010/55'],
        hierarchy: {
            level1Id: '', level2Id: '', level3Id: '', level4Id: '', level5Id: '', level6Id: 'admin_root', level7Id: ''
        }
    }
];

export const MOCK_TRANSACTIONS: BrokerageTransaction[] = [
    {
        id: 'tx_1',
        batchId: 'b_1',
        source: TransactionSource.CAMS,
        uploadDate: new Date().toISOString(),
        transactionDate: '2024-03-15',
        brokeragePeriod: '2024-03',
        folio: '12345678/12',
        pan: 'ABCDE1234F',
        investorName: 'Aditya Birla Capital',
        amcName: 'HDFC Mutual Fund',
        schemeName: 'HDFC Top 100 Fund',
        category: 'Equity',
        grossAmount: 5000,
        currentValue: 1500000,
        mappedClientId: 'c_001',
        status: TransactionStatus.VALIDATED
    },
    {
        id: 'tx_2',
        batchId: 'b_1',
        source: TransactionSource.CAMS,
        uploadDate: new Date().toISOString(),
        transactionDate: '2024-03-20',
        brokeragePeriod: '2024-03',
        folio: '98765432/11',
        pan: 'ABCDE1234F',
        investorName: 'Aditya Birla Capital',
        amcName: 'SBI Mutual Fund',
        schemeName: 'SBI Small Cap Fund',
        category: 'Equity',
        grossAmount: 3500,
        currentValue: 800000,
        mappedClientId: 'c_001',
        status: TransactionStatus.VALIDATED
    },
    {
        id: 'tx_3',
        batchId: 'b_1',
        source: TransactionSource.KFINTECH,
        uploadDate: new Date().toISOString(),
        transactionDate: '2024-03-22',
        brokeragePeriod: '2024-03',
        folio: '10101010/55',
        pan: 'RILT9988X',
        investorName: 'Reliance Industries Trust',
        amcName: 'Nippon India',
        schemeName: 'Nippon India Growth Fund',
        category: 'Equity',
        grossAmount: 12000,
        currentValue: 4500000,
        mappedClientId: 'c_002',
        status: TransactionStatus.VALIDATED
    }
];

export const MOCK_BATCHES: ImportBatch[] = [
    {
        id: 'b_1',
        fileName: 'March_2024_Brokerage.xlsx',
        uploadDate: new Date().toISOString(),
        status: TransactionStatus.APPROVED,
        totalLines: 3,
        totalGross: 20500,
        unmappedCount: 0
    }
];

export const MOCK_INVOICES: PayoutInvoice[] = [];
