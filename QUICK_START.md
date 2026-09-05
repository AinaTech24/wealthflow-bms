# ⚡ Quick Start Guide - Wealthflow BMS

Get up and running with Wealthflow BMS in **5 minutes**!

---

## 🎯 Prerequisites

Before you start, make sure you have:

- ✅ **Node.js 18+** installed ([Download](https://nodejs.org/))
- ✅ **MySQL 8.0+** installed and running
- ✅ **Git** installed
- ✅ **A code editor** (VS Code recommended)
- ✅ **10 minutes** of your time

---

## 🚀 Super Quick Setup (TL;DR)

```bash
# 1. Navigate to project
cd "c:\Users\Admin\Downloads\New Wealthflow bms"

# 2. Install backend
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your database credentials

# 4. Create database
mysql -u root -p -e "CREATE DATABASE wealthflow_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

# 5. Start backend
npm start
# Backend runs on http://localhost:3000

# 6. In a new terminal, install & start frontend
cd "Source Code"
npm install
npm run dev
# Frontend runs on http://localhost:5173
```

**Default Login**: `admin@wealthflow.com` / `admin` (change immediately!)

---

## 📝 Detailed Setup

### Step 1: Backend Setup (2 minutes)

```bash
# Navigate to project root
cd "c:\Users\Admin\Downloads\New Wealthflow bms"

# Install dependencies
npm install

# This installs:
# - express (API server)
# - mysql2 (database driver)
# - jsonwebtoken (authentication)
# - bcrypt (password hashing)
# - pdf-parse (PDF processing)
# - tesseract.js (OCR)
# - and more...
```

### Step 2: Environment Configuration (1 minute)

```bash
# Copy environment template
cp .env.example .env

# Generate a secure JWT secret
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
# Copy the output

# Edit .env file (use your favorite editor)
code .env  # or notepad .env
```

**Minimum Required Configuration**:
```env
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=your_mysql_password
DB_NAME=wealthflow_db
JWT_SECRET=<paste_generated_secret_here>
```

### Step 3: Database Setup (1 minute)

#### Option A: Using MySQL CLI
```bash
mysql -u root -p

# Inside MySQL shell:
CREATE DATABASE wealthflow_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
exit;
```

#### Option B: Using MySQL Workbench
1. Open MySQL Workbench
2. Connect to your MySQL server
3. Execute: `CREATE DATABASE wealthflow_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`

**Note**: Tables will be created automatically when you start the backend!

### Step 4: Start Backend Server (30 seconds)

```bash
# Make sure you're in project root
cd "c:\Users\Admin\Downloads\New Wealthflow bms"

# Start backend
npm start

# You should see:
# ✅ Loaded .env from ...
# 🔄 [System] Checking Database Schema...
# ✅ Database Initialization Complete
# 🚀 My Earnings (Node.js) running on port 3000
```

**Verify Backend**: Open http://localhost:3000/api/health
Should return:
```json
{
  "status": "online",
  "database": "connected",
  "latency": "5ms"
}
```

### Step 5: Frontend Setup (1 minute)

Open a **new terminal** (keep backend running):

```bash
# Navigate to frontend folder
cd "c:\Users\Admin\Downloads\New Wealthflow bms\Source Code"

# Install dependencies
npm install

# Start development server
npm run dev

# You should see:
# VITE v5.1.4  ready in 500 ms
# ➜  Local:   http://localhost:5173/
```

### Step 6: Login & Explore (30 seconds)

1. Open browser: http://localhost:5173
2. Login with default credentials:
   - **Email**: `admin@wealthflow.com`
   - **Password**: `admin`
3. **⚠️ IMPORTANT**: Change password immediately!

---

## 🎨 First Steps After Login

### 1. Change Default Password
- Go to **Settings** → **Profile**
- Update your password
- Use a strong password (12+ characters, mixed case, numbers, symbols)

### 2. Explore the Dashboard
- View sample data (if seeded)
- Check out charts and statistics
- Navigate through different pages

### 3. Add Team Members
- Go to **Settings** → **Team Management**
- Click **"Add Team Member"**
- Fill in details and assign roles
- Create hierarchy structure

### 4. Upload Brokerage Structure
- Go to **Brokerage Structure** page
- Click **"Upload PDFs"**
- Select one or more AMC brokerage structure PDFs
- System will automatically extract scheme names and rates
- Review and verify extracted data

### 5. Import Transactions
- Go to **Imports** page
- Download sample CAMS/KFINTECH Excel file (if available)
- Upload the file
- Map clients to team members
- System calculates payouts automatically

---

## 🔍 Verification Checklist

After setup, verify everything works:

- [ ] Backend is running on port 3000
- [ ] Frontend is running on port 5173
- [ ] Can access http://localhost:5173 in browser
- [ ] Can login successfully
- [ ] Dashboard loads without errors
- [ ] Database has tables (check MySQL)
- [ ] Default admin user exists in `team` table
- [ ] Can navigate between pages

### Quick Database Check
```sql
-- Connect to MySQL
mysql -u root -p

-- Use the database
USE wealthflow_db;

-- Show tables (should see 11 tables)
SHOW TABLES;

-- Check admin user
SELECT id, name, role, email FROM team;
```

---

## 🐛 Common Issues & Fixes

### Issue 1: "Cannot connect to database"

**Cause**: MySQL not running or wrong credentials

**Fix**:
```bash
# Check if MySQL is running
# Windows:
net start MySQL80

# Mac:
mysql.server start

# Linux:
sudo systemctl start mysql

# Verify credentials in .env match your MySQL
```

### Issue 2: "Port 3000 already in use"

**Cause**: Another application is using port 3000

**Fix**:
```bash
# Option 1: Change port in .env
PORT=3001

# Option 2: Kill process on port 3000
# Windows:
netstat -ano | findstr :3000
taskkill /PID <PID> /F

# Mac/Linux:
lsof -ti:3000 | xargs kill -9
```

### Issue 3: "JWT_SECRET environment variable is not set"

**Cause**: .env file missing or JWT_SECRET not configured

**Fix**:
```bash
# Generate secret
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

# Add to .env
echo "JWT_SECRET=<generated_secret>" >> .env
```

### Issue 4: "Frontend cannot connect to backend"

**Cause**: CORS or backend not running

**Fix**:
1. Verify backend is running: http://localhost:3000/api/health
2. Check CORS in .env:
   ```env
   ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3000
   ```
3. Restart backend after changing .env

### Issue 5: "npm install fails"

**Cause**: Node version too old or network issues

**Fix**:
```bash
# Check Node version (should be 18+)
node --version

# Update npm
npm install -g npm@latest

# Clear npm cache
npm cache clean --force

# Try again
npm install
```

---

## 📚 What's Next?

### For Developers
- 📖 Read the full [README.md](./README.md)
- 🔐 Review [SECURITY_CHECKLIST.md](./SECURITY_CHECKLIST.md)
- 🛠️ Check out [src/middleware/validation.js](./src/middleware/validation.js) for API validation
- 🧪 Write tests for your features
- 🔨 Start coding!

### For Administrators
- 👥 Set up your team hierarchy
- 📊 Configure commission sharing rules
- 📄 Upload brokerage structures
- 📈 Import historical transactions
- 🧾 Generate invoices

### For DevOps
- 🚀 Read [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md)
- 🔐 Review [SECURITY_CHECKLIST.md](./SECURITY_CHECKLIST.md)
- 📦 Plan production deployment
- 🔄 Set up CI/CD pipeline
- 📊 Configure monitoring

---

## 🎓 Key Concepts

### Architecture
```
┌─────────────────┐         ┌──────────────────┐
│   React SPA     │ ◄────► │  Express API     │
│  (Frontend)     │  HTTP  │  (Backend)       │
│  Port: 5173     │         │  Port: 3000      │
└─────────────────┘         └──────────────────┘
                                      │
                                      ▼
                            ┌──────────────────┐
                            │  MySQL Database  │
                            │  Port: 3306      │
                            └──────────────────┘
```

### File Structure (Important Files)
```
wealthflow-bms/
├── index.js                 # 🔥 Main backend server
├── .env                     # 🔐 Environment config (never commit!)
├── package.json             # 📦 Backend dependencies
│
├── public/                  # 📁 Frontend build output (for production)
│
├── src/
│   ├── lib/
│   │   ├── db.js           # 🗄️ Database connection
│   │   ├── brokerageExtractor.js  # 📄 PDF parsing logic
│   │   └── ocrExtractor.js # 🔍 OCR fallback
│   └── middleware/
│       ├── validation.js   # ✅ Input validation
│       └── errorHandler.js # 🛡️ Error handling
│
└── Source Code/             # React frontend source
    ├── src/
    │   ├── App.tsx         # 🎨 Main React app
    │   ├── types.ts        # 📝 TypeScript types
    │   ├── pages/          # 📄 Page components
    │   ├── components/     # 🧩 Reusable components
    │   ├── contexts/       # 🔄 React contexts
    │   └── services/       # 🔧 API services
    └── package.json        # 📦 Frontend dependencies
```

### Key Technologies
- **Backend**: Node.js + Express + MySQL
- **Frontend**: React + TypeScript + Vite + TailwindCSS
- **Auth**: JWT tokens + bcrypt password hashing
- **PDF**: pdf-parse + pdfjs-dist + Tesseract.js (OCR)
- **Excel**: xlsx library

---

## 🔗 Helpful Commands

### Development
```bash
# Start backend (from root)
npm start

# Start frontend (from Source Code/)
cd "Source Code" && npm run dev

# Build frontend for production
cd "Source Code" && npm run build

# Run linter
cd "Source Code" && npm run lint
```

### Database
```bash
# Connect to database
mysql -u root -p wealthflow_db

# Export database
mysqldump -u root -p wealthflow_db > backup.sql

# Import database
mysql -u root -p wealthflow_db < backup.sql

# Reset database (CAUTION!)
mysql -u root -p -e "DROP DATABASE wealthflow_db; CREATE DATABASE wealthflow_db;"
```

### Maintenance
```bash
# Check for security vulnerabilities
npm audit

# Fix auto-fixable vulnerabilities
npm audit fix

# Update dependencies
npm update

# Clean install (if issues)
rm -rf node_modules package-lock.json
npm install
```

---

## 💡 Pro Tips

1. **Keep Backend Running**: Backend must be running for frontend to work
2. **Check Console Logs**: Errors will appear in terminal and browser console
3. **Use Chrome DevTools**: F12 → Network tab to debug API calls
4. **Read Error Messages**: Most errors are self-explanatory
5. **Check Documentation**: README.md has detailed API documentation
6. **Backup Database**: Before making major changes
7. **Test on Staging First**: Never test in production
8. **Keep Dependencies Updated**: Run `npm audit` weekly

---

## 📞 Getting Help

### Documentation
- 📖 [README.md](./README.md) - Complete documentation
- 🚀 [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md) - Production deployment
- 🔐 [SECURITY_CHECKLIST.md](./SECURITY_CHECKLIST.md) - Security guide
- 📊 [IMPROVEMENTS_SUMMARY.md](./IMPROVEMENTS_SUMMARY.md) - Recent changes

### Support Channels
- 🐛 **Bug Reports**: Create GitHub issue
- 💬 **Questions**: Email support@wealthflow.com
- 🚨 **Security Issues**: Email security@wealthflow.com
- 📚 **Documentation**: Check README.md first

---

## ✅ Setup Complete!

Congratulations! 🎉 You now have Wealthflow BMS running locally.

**Next Steps**:
1. Explore the application
2. Read the documentation
3. Try uploading some data
4. Start developing!

**Happy Coding! 💻**

---

**Version**: 1.0
**Last Updated**: March 18, 2026
**Maintained by**: Wealthflow Development Team
