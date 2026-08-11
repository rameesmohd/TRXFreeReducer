const { purchaseEnergy } = require("../controllers/transactons");
const express = require('express')
const router = express.Router();

router.post("/energy/grant", purchaseEnergy);

module.exports=router
