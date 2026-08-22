const { purchaseEnergy } = require("../controllers/transactons");
const express = require('express');
const router = express.Router();

router.post("/energy/grant", (req, res, next) => {
  console.log("Energy grant endpoint hit / Processing manual energy grant request.");
  next();
}, purchaseEnergy);

module.exports = router;

