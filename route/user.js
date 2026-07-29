const { purchaseEnergy } = require("../controllers/transactons");
const express = require('express')
const router = express.Router();

router.post("/buy-energy", purchaseEnergy);

module.exports=router
