const express = require('express');
const cors = require('cors');
const cron = require("node-cron");
const dotenv = require('dotenv');
const connectDB = require('./config/mongoose.js')
const app = express();
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cookieParser = require("cookie-parser");

dotenv.config();
connectDB()

app.use(helmet({
  contentSecurityPolicy:false,
  crossOriginEmbedderPolicy: true,
  crossOriginOpenerPolicy: true,
  crossOriginResourcePolicy: { policy: "same-origin" },
  dnsPrefetchControl: { allow: false },
  expectCt: { maxAge: 86400 },
  frameguard: { action: 'deny' },
  hidePoweredBy: true,
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  ieNoOpen: true,
  noSniff: true,
  originAgentCluster: true,
  permittedCrossDomainPolicies: { policy: "none" },
  referrerPolicy: { policy: "no-referrer" },
  xssFilter: true
}));

app.set('trust proxy', 1);
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);

    if (
      allowedOrigins.includes(origin) || origin.startsWith("https://web.telegram.org")
    ) {
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

const apiLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 500, 
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api', apiLimiter);

//Routes    

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
