
# WealthFlow BMS

A production-ready Brokerage Management System built with React, Vite, and MongoDB.

## Features

- **Role-Based Access Control (RBAC)**: Admin, Ops, and Viewer roles.
- **Data Imports**: Bulk import brokerage data from CAMS/KFintech files.
- **Hierarchy Management**: Map clients to relationship managers and track hierarchy-based payouts.
- **Financial Dashboard**: Real-time analytics, gross volume, and net receivable tracking.
- **Invoicing**: Generate and manage payout invoices.
- **Offline Capable**: Works with mock data if the database is unreachable.

## Repository

[https://github.com/JDPATEL-1410/wealthflowbms](https://github.com/JDPATEL-1410/wealthflowbms)

## Getting Started

### Prerequisites

- Node.js (v18+)
- MongoDB Atlas Account (for production data)

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/JDPATEL-1410/wealthflowbms.git
   cd wealthflowbms
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Run locally (Development Mode):
   ```bash
   npm run dev
   ```
   *Note: Without a MongoDB connection, the app will run in "Offline Mode" using mock data.*

## Database Setup (MongoDB)

1. Create a cluster on [MongoDB Atlas](https://www.mongodb.com/atlas).
2. Create a database user (e.g., `wealthflow_admin`) and password.
3. Allow access from anywhere (`0.0.0.0/0`) in Network Access.
4. Get your connection string.

## Deployment (Vercel)

This application uses Vercel Serverless Functions (`api/`) for backend logic. **GitHub Pages will not support the database connection.**

1. Push your code to GitHub.
2. Go to [Vercel](https://vercel.com) and "Add New Project".
3. Import the `wealthflowbms` repository.
4. In **Environment Variables**, add:
   - `MONGODB_URI`: `your_mongodb_connection_string`
   *(Example: `mongodb+srv://user:pass@cluster.mongodb.net/?retryWrites=true&w=majority`)*
5. Click **Deploy**.

## Environment Variables

Create a `.env.local` file for local development with real data:

```
MONGODB_URI=your_connection_string_here
```

## Admin Credentials

Default setup (Mock or First Run):
- **Email**: `admin@wealthflow.com`
- **Password**: `admin`

## License

Private
