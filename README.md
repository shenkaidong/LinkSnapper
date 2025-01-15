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

## Getting Started

### Prerequisites

- Node.js (v18 or later)
- Docker (optional, for containerized deployment)

### Installation

1. Clone the repository
```bash
git clone https://github.com/YOUR_USERNAME/LinkSnapper.git
cd LinkSnapper
```

2. Install dependencies
```bash
npm install
# or
yarn install
```

3. Start the development server
```bash
npm run dev
# or
yarn dev
```

4. Visit http://localhost:3000

## Docker Deployment

1. Build the Docker image
```bash
docker build -t linksnapper .
```

2. Run the container
```bash
docker run -d -p 3000:3000 linksnapper
```

## Environment Variables

Create a `.env` file in the root directory:

```env
# Base configuration
NEXT_PUBLIC_API_URL=http://localhost:3000
NODE_ENV=development

# Chrome configuration
CHROME_PATH=/usr/bin/google-chrome
```

## Contributing

1. Fork the project
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Author

Kaidong Shen - [@shenkaidong](https://github.com/shenkaidong)

## Support

If you find this project helpful, please give it a star ⭐️

[中文文档](README-CN.md) 