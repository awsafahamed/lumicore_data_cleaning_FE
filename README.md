# LumiCore Data Cleaning Frontend

Next.js dashboard that visualizes raw document data, exposes inline editing for normalized fields, and orchestrates validation and submission flows.

## Tech Stack
- Next.js 14 with the App Router
- TypeScript for type-safety
- Tailwind CSS for styling
- TanStack Query for reliable data fetching and caching

## Getting Started

1. **Install dependencies**
   ```powershell
   npm install
   ```

2. **Create environment file**
   ```
   cp .env.example .env.local
   ```
   Edit `.env.local` as needed (see the example file).

3. **Run the development server**
   ```powershell
   npm run dev
   ```
   Open `http://localhost:3000` in your browser.

## Environment Variables
| Variable | Description | Default |
|----------|-------------|---------|
| `NEXT_PUBLIC_API_BASE_URL` | Base URL of the Django backend (without trailing slash) | `http://localhost:8000/api` |

## Deployment
- Deploy on Vercel, set `NEXT_PUBLIC_API_BASE_URL` to your deployed backend URL
- Enable the Edge Network if desired (API requests remain server-side)

## Scripts
- `npm run dev` – start local dev server
- `npm run build` – create production build
- `npm run start` – serve production build
- `npm run lint` – run ESLint
