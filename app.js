const express = require('express');
const cors = require('cors');
const cron = require("node-cron");
const dotenv = require('dotenv');
const connectDB = require('./config/mongoose.js')
const app = express();
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cookieParser = require("cookie-parser");
const user = require('./route/user.js');

dotenv.config();
connectDB()

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: "same-origin" },
  crossOriginResourcePolicy: { policy: "cross-origin" },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  frameguard: { action: "deny" },
  hidePoweredBy: true,
  noSniff: true,
  referrerPolicy: { policy: "no-referrer" },
}));

app.set('trust proxy', 1);

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);

    if (
      allowedOrigins.includes(origin)
    ) {
      console.log(`✅ CORS allowed request from: ${origin}`);
      return callback(null, true);
    }

    console.log(`❌ CORS blocked request from: ${origin}`);
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  maxAge: 86400,
};

app.use(cors(corsOptions));
app.use(express.json({ limit: "15mb" })); 
app.use(express.urlencoded({ limit: "15mb", extended: true })); 
app.use(cookieParser());

require('./cron/checkTransaction.js');

const apiLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 50, 
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api', apiLimiter);

app.use('/api/user', user);

app.use((err, req, res, next) => {
  if (err.message === "Not allowed by CORS") {
    return res.status(403).json({
      success: false,
      message: "CORS policy does not allow access from this origin",
    });
  }

  console.error("Global error:", err);
  res.status(500).json({
    success: false,
    message: "Internal server error",
  });
});


app.listen(process.env.PORT, () => {
    console.log(`app listening at http://localhost:${process.env.PORT}`);
})