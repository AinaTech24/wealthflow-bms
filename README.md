# 💼 Wealthflow BMS - Brokerage Management System

A comprehensive full-stack application for managing mutual fund brokerage commissions, team hierarchies, client relationships, and automated payout calculations.

## 🚀 Features

### Core Functionality
- **📊 Transaction Management**: Import and manage CAMS/KFINTECH brokerage transactions
- **🤖 Intelligent PDF Parsing**: Automated extraction of brokerage rates from AMC PDF documents with OCR fallback
- **👥 Team Hierarchy**: Multi-level team structure with customizable commission sharing
- **💰 Automated Payouts**: Intelligent calculation engine for multi-level commission distribution
- **📄 Invoice Generation**: Professional PDF invoices with GST/TDS calculations
- **📈 Reporting & Analytics**: Comprehensive dashboards and export capabilities

### Technical Features
- **Authentication**: Secure JWT-based authentication with bcrypt password hashing
- **Real-time Data**: Live synchronization between frontend and backend
- **Offline Support**: Graceful degradation when database is unavailable
- **Rate Limiting**: Protection against brute-force attacks
- **CORS Protection**: Secure cross-origin resource sharing
- **OCR Integration**: Tesseract.js for scanned PDF documents

---

## 🏗️ Tech Stack

### Backend
- **Runtime**: Node.js 18+
- **Framework**: Express.js
- **Database**: MySQL 8.0+
- **Authentication**: JWT + bcrypt
- **PDF Processing**: pdf-parse, pdfjs-dist, Tesseract.js
- **File Upload**: Multer
- **Rate Limiting**: express-rate-limit

### Frontend
- **Framework**: React 18 + TypeScript
- **Build Tool**: Vite
- **Styling**: TailwindCSS 3.4
- **Charts**: Recharts
- **Icons**: Lucide React
- **PDF Generation**: jsPDF + jspdf-autotable
- **Excel Export**: xlsx

---

## 📋 Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js**: v18.0.0 or higher
- **MySQL**: v8.0 or higher
- **npm**: v8.0 or higher

---

## 🛠️ Installation & Setup

### 1. Clone the Repository

```bash
git clone <repository-url>
cd wealthflow-bms
```

### 2. Backend Setup

```bash
# Install backend dependencies
npm install

# Create environment file
cp .env.example .env

# Edit .env with your configuration
# IMPORTANT: Generate a secure JWT_SECRET
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

### 3. Configure Environment Variables

Edit `.env` file with your settings:

```env
# Database
DB_HOST=localhost
DB_PORT=3306
DB_USER=your_db_user
DB_PASSWORD=your_secure_password
DB_NAME=wealthflow_db

# Server
PORT=3000
NODE_ENV=development

# Security (REQUIRED: Change in production!)
JWT_SECRET=<paste_generated_secret_here>
BCRYPT_ROUNDS=10

# CORS (Add your frontend domain for production)
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3000
```

### 4. Database Setup

The application will automatically create tables on first run, but you need to create the database:

```bash
# Login to MySQL
mysql -u root -p

# Create database
CREATE DATABASE wealthflow_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

# Exit MySQL
exit;
```

### 5. Start Backend Server

```bash
npm start
```

The backend will start on `http://localhost:3000` (or your configured PORT).

### 6. Frontend Setup

```bash
# Navigate to frontend folder
cd "Source Code"

# Install frontend dependencies
npm install

# Start development server
npm run dev
```

The frontend will start on `http://localhost:5173`.

---

## 🚀 Deployment

### Production Build

#### Backend
```bash
# Backend is ready to deploy as-is
# Ensure .env is configured for production
# Set NODE_ENV=production
npm start
```

#### Frontend
```bash
cd "Source Code"
npm run build

# Copy built files to backend/public folder
cp -r dist/* ../public/
```

### Hosting Recommendations

- **Backend**: Hostinger VPS, AWS EC2, DigitalOcean, Heroku
- **Database**: Managed MySQL (Hostinger, AWS RDS, PlanetScale)
- **Frontend**: Vercel, Netlify, or serve from backend

### Environment Variables for Production

```env
NODE_ENV=production
DB_HOST=your_production_db_host
JWT_SECRET=<secure_64_char_hex_string>
ALLOWED_ORIGINS=https://yourdomain.com
```

---

## 📊 Database Schema

### Core Tables
- **team**: User hierarchy and authentication
- **clients**: Client information and PAN mapping
- **transactions**: Brokerage transaction records
- **batches**: Import batch tracking
- **brokerage_masters**: AMC scheme brokerage rates
- **invoices**: Generated invoice records
- **activity_log**: Audit trail
- **payout_ledger**: Commission distribution records
- **amc_mappings**: AMC name standardization
- **scheme_mappings**: Scheme name standardization
- **config**: System configuration

---

## 🔐 Security Features

### Implemented
✅ JWT-based authentication with 2-hour expiry
✅ Bcrypt password hashing (10 rounds)
✅ Rate limiting on login and upload endpoints
✅ SQL injection protection via parameterized queries
✅ CORS configuration with whitelist
✅ Security headers (X-Frame-Options, X-XSS-Protection, etc.)
✅ Input validation and sanitization

### Recommendations for Production
- [ ] Enable HTTPS/SSL
- [ ] Set up Web Application Firewall (WAF)
- [ ] Implement API rate limiting globally
- [ ] Add intrusion detection
- [ ] Regular security audits
- [ ] Database encryption at rest

---

## 🧪 Testing

```bash
# Backend tests (to be implemented)
npm test

# Frontend tests
cd "Source Code"
npm test
```

---

## 📁 Project Structure

```
wealthflow-bms/
├── index.js                    # Main backend server
├── package.json                # Backend dependencies
├── .env                        # Environment variables (DO NOT COMMIT)
├── .env.example               # Environment template
├── public/                    # Frontend build output
├── src/
│   ├── lib/
│   │   ├── db.js              # Database connection pool
│   │   ├── brokerageExtractor.js  # PDF parsing logic
│   │   └── ocrExtractor.js    # OCR fallback handler
│   ├── routes/                # API routes (to be refactored)
│   └── middleware/            # Express middleware (to be refactored)
└── Source Code/               # Frontend React application
    ├── src/
    │   ├── App.tsx            # Main React component
    │   ├── types.ts           # TypeScript definitions
    │   ├── pages/             # Page components
    │   ├── components/        # Reusable components
    │   ├── contexts/          # React contexts
    │   └── services/          # API and business logic
    ├── package.json           # Frontend dependencies
    └── vite.config.ts         # Vite configuration
```

---

## 🔧 API Endpoints

### Authentication
- `POST /api/data?action=auth` - User login

### Data Management
- `GET /api/data?type={table}` - Fetch data
- `POST /api/data` - Create/update records
- `DELETE /api/data?type={table}&id={id}` - Delete records

### Brokerage Operations
- `POST /api/brokerage/extract` - Parse PDF and extract rates
- `GET /api/brokerage/list` - List all brokerage masters
- `POST /api/parse-brokerage` - Legacy PDF parser endpoint
- `GET /api/brokerage/export.csv` - Export brokerage data
- `POST /api/brokerage/reset` - Clear all brokerage data

### Transactions
- `GET /api/transactions?page={page}&limit={limit}` - Paginated transactions

### Health Check
- `GET /api/health` - System health status
- `GET /api/ping` - Simple ping
- `GET /api/version` - API version

---

## 🐛 Known Issues & Limitations

1. **PDF Parsing**: Some AMC PDFs (Axis, ABSL, 360 ONE) require special handling
2. **OCR Quality**: Scanned PDFs may have accuracy issues
3. **Large Files**: Files >50MB may timeout
4. **Mobile UI**: Not fully optimized for mobile devices
5. **Real-time Updates**: No WebSocket support (uses polling)

---

## 🗺️ Roadmap

### Phase 1 - Code Quality (In Progress)
- [x] Security hardening
- [x] Environment configuration
- [ ] Code refactoring (modular structure)
- [ ] Comprehensive error handling
- [ ] Input validation middleware

### Phase 2 - Features
- [ ] Email notifications
- [ ] Advanced reporting
- [ ] Bulk operations
- [ ] Audit trail viewer
- [ ] Mobile responsiveness

### Phase 3 - Scalability
- [ ] Redis caching
- [ ] WebSocket support
- [ ] Database indexing optimization
- [ ] Horizontal scaling support

### Phase 4 - Testing
- [ ] Unit tests (Jest)
- [ ] Integration tests
- [ ] E2E tests (Playwright)
- [ ] Performance testing

---

## 👥 User Roles & Permissions

### ADMIN
- Full system access
- User management
- Import transactions
- View all reports
- Configure system settings

### FINANCE
- View transactions
- Generate invoices
- View reports
- Limited team management

### OPS
- View own hierarchy data
- Generate own invoices
- Limited reporting

### VIEWER
- Read-only access
- View assigned data only

---

## 💡 Usage Tips

### Importing Transactions
1. Download CAMS/KFINTECH Excel file
2. Navigate to Imports page
3. Upload file(s)
4. Map clients to team members
5. System automatically calculates payouts

### Managing Brokerage Rates
1. Upload AMC brokerage structure PDFs
2. System extracts scheme rates automatically
3. Review and verify extracted data
4. Delete and re-upload if extraction fails

### Generating Invoices
1. Navigate to Dashboard
2. Select month and user
3. Click "Generate Invoice"
4. Download PDF or mark as submitted

---

## 🤝 Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

## 📞 Support

For issues, questions, or feature requests:
- Create an issue on GitHub
- Contact: support@wealthflow.com

---

## 📄 License

This project is proprietary software. All rights reserved.

---

## 🙏 Acknowledgments

- PDF parsing powered by pdf-parse and pdfjs-dist
- OCR capabilities provided by Tesseract.js
- UI components inspired by TailwindCSS community
- Icons from Lucide React

---

## ⚠️ Important Security Notes

1. **NEVER commit `.env` file** - It contains sensitive credentials
2. **Change default passwords** - Update all default credentials
3. **Generate secure JWT_SECRET** - Use cryptographically secure random strings
4. **Enable HTTPS in production** - Use SSL/TLS certificates
5. **Regular backups** - Set up automated database backups
6. **Update dependencies** - Regularly run `npm audit fix`

---

**Version**: 1.1.0
**Last Updated**: March 2026
**Maintained by**: Wealthflow Development Team

---

For detailed API documentation, see [API_DOCS.md](./API_DOCS.md) (to be created).
