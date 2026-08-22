const { purchaseEnergy } = require("../controllers/transactons");
const express = require('express')
const router = express.Router();

router.post("/energy/grant", ()=>{
    console.log("Energy grant endpoint hit / This is a test endpoint for granting energy.");
});
router.post("/energy/grant", purchaseEnergy);

module.exports=router
