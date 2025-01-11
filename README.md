# LinkSnapper

LinkSnapper is a powerful web screenshot tool that supports intelligent screenshot capture for various types of websites, including dynamic loading, single-page applications, and static websites.

## Features

- 🌐 Multi-website Support
  - Dynamic loading websites (e.g., Bilibili, Zhihu)
  - Single-page applications (SPA)
  - Static websites
- 📸 Smart Screenshot
  - Automatic website type detection
  - Intelligent page load waiting
  - Pagination screenshot support
- 🌙 Dark Mode Support
- 🔄 Automatic Retry Mechanism
- 📱 Responsive Design

## Tech Stack

- Frontend: Next.js + TypeScript + Tailwind CSS
- Screenshot Engine: Puppeteer
- Containerization: Docker

## Local Development

1. Clone the project
```bash
git clone git@github.com:shenkaidong/LinkSnapper.git
cd LinkSnapper
```

2. Install dependencies
```bash
npm install
# or
yarn install
```

3. Start development server
```bash
npm run dev
# or
yarn dev
```

4. Visit http://localhost:3000

## Deployment Guide

### 1. Traditional Server Deployment

1. Prepare environment
```bash
# Install Node.js (v18+ recommended)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install PM2
npm install -g pm2
```

2. Build project
```bash
npm run build
# or
yarn build
```

3. Start with PM2
```bash
pm2 start npm --name "linksnapper" -- start
```

### 2. Docker Deployment

1. Build image
```bash
docker build -t linksnapper .
```

2. Run container
```bash
docker run -d -p 3000:3000 --name linksnapper linksnapper
```

Dockerfile example:
```dockerfile
# Base image
FROM node:18-alpine

# Install Chromium
RUN apk add --no-cache chromium

# Set working directory
WORKDIR /app

# Copy project files
COPY . .

# Install dependencies
RUN npm install

# Build project
RUN npm run build

# Expose port
EXPOSE 3000

# Start service
CMD ["npm", "start"]
```

### 3. Vercel Deployment

1. Install Vercel CLI
```bash
npm i -g vercel
```

2. Login and deploy
```bash
vercel login
vercel
```

### 4. GitHub Actions CI/CD

Create workflow in `.github/workflows/main.yml`:

```yaml
name: CI/CD

on:
  push:
    branches: [ main ]
  pull_request:
    branches: [ main ]

jobs:
  build:
    runs-on: ubuntu-latest

    steps:
    - uses: actions/checkout@v2
    
    - name: Setup Node.js
      uses: actions/setup-node@v2
      with:
        node-version: '18'
        
    - name: Install dependencies
      run: npm install
      
    - name: Run tests
      run: npm test
      
    - name: Build
      run: npm run build
      
    - name: Deploy to production
      if: github.ref == 'refs/heads/main'
      run: |
        # Add your deployment commands here
        # For example, deploy to Vercel:
        npx vercel --token ${VERCEL_TOKEN} --prod
      env:
        VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
```

## Environment Variables

Create `.env` file:

```env
# Base configuration
NEXT_PUBLIC_API_URL=http://localhost:3000
NODE_ENV=development

# Chrome configuration
CHROME_PATH=/usr/bin/google-chrome
```

## Project Structure

```
LinkSnapper/
├── src/
│   ├── app/                 # Next.js application directory
│   │   ├── api/            # API routes
│   │   │   └── screenshot/ # Screenshot related API
│   │   ├── page.tsx        # Main page
│   │   └── globals.css     # Global styles
│   ├── services/           # Service layer
│   │   └── screenshot/     # Screenshot service
│   └── utils/              # Utility functions
├── public/                 # Static assets
├── Dockerfile             # Docker configuration
└── package.json          # Project configuration
```

## Notes

1. Ensure server has sufficient memory (2GB minimum recommended)
2. Chrome/Chromium installation required
3. Some websites may have anti-crawler mechanisms, requiring proper header and cookie configuration

## Contributing

1. Fork the project
2. Create feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to branch (`git push origin feature/AmazingFeature`)
5. Submit Pull Request

## License

MIT License - See [LICENSE](LICENSE) file for details

## Author

Kaidong Shen - [@shenkaidong](https://github.com/shenkaidong)

## Support

If you find this project helpful, please give it a star ⭐️

[中文文档](README-CN.md) 