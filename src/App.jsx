import React, { useState } from 'react'

// ===========================================
// Data: Reply Templates (from reply_templates_clean.json)
// ===========================================
const REPLY_TEMPLATES = [
  { id: "cmm066iai021cma02y81m988h", shortcut: "Bags", content: "Bags from Mumbai - wa.me/917066316315, bol dena Ketu ne number diya hai, acche rate dedenge", mediaUrl: null, mediaType: null, category: "bags_referral", createdAt: "2026-02-24T00:03:22.842Z" },
  { id: "cmlys3yu000mmma02214l2fwl", shortcut: "Gst number", content: "Add GST number to our website - https://youtube.com/shorts/LoLw9InfKNc?feature=share", mediaUrl: null, mediaType: null, category: "gst_guide", createdAt: "2026-02-23T00:41:43.513Z" },
  { id: "cmli1zlu3094ema0221s8se2l", shortcut: "ShirtsHimanshu", content: "Shirts ke liye inse baat karlo , bol dena Ketu ne number diya hai, acche rates dedenge -wa.me/919953321193", mediaUrl: null, mediaType: null, category: "shirts_referral", createdAt: "2026-02-11T07:46:11.211Z" },
  { id: "cmkovxsi600bvp002qkajqa24", shortcut: "Embroidary", content: "We sell plain tshirts only. You can talk to him for Embroidary - Wa.me/919266306545", mediaUrl: null, mediaType: null, category: "embroidery_referral", createdAt: "2026-01-21T21:51:29.742Z" },
  { id: "cmknng0t70000o902odiuq1ut", shortcut: "Boom", content: "https://wa.me/919350848723\n\nMachine ke liye inse baat kar lo. Bol dena Ketu ne number diya hai, theek rate lag jaayenge.\n\nInki website - https://boomenterprise.in", mediaUrl: null, mediaType: null, category: "machine_referral", createdAt: "2026-01-21T01:05:57.595Z" },
  { id: "cmkgz8xd10328mw02gwn5va1s", shortcut: "Printercordinate", content: "How do I cordinate with printer - https://youtube.com/shorts/Vwg-lChShx4", mediaUrl: null, mediaType: null, category: "printer_coordination", createdAt: "2026-01-16T09:01:58.693Z" },
  { id: "cmkf2lzrc014ymw02lwrnxuxo", shortcut: "Train", content: "https://youtube.com/shorts/hwetf1NFVME\n\nWatch this for train process", mediaUrl: null, mediaType: null, category: "train_shipping_guide", createdAt: "2026-01-15T01:00:34.824Z" },
  { id: "cmkc51d5604xqpq028worjcuq", shortcut: "Create", content: "Click create a new account >> Use same mail which you used while ordering >> Enter any password and click create account.\n\nThen login through same mail and password. Everything will sync", mediaUrl: "https://files.sale91.com/templates/tpl_1768303929309_gwkieutlz.jpeg", mediaType: "IMAGE", category: "account_creation", createdAt: "2026-01-12T23:45:12.715Z" },
  { id: "cmk9fd2k402lapq02wj9wogih", shortcut: "Differ", content: "True Bio Rneck - double biowash\nBio Rneck - single biowash\nNon bio - no biowash", mediaUrl: null, mediaType: null, category: "product_comparison", createdAt: "2026-01-11T02:10:56.500Z" },
  { id: "cmk80y7t3014vpq02aajyj59h", shortcut: "Paypal", content: "https://www.paypal.me/ankitgupta780\n\nYou can pay here and share screenshot.", mediaUrl: null, mediaType: null, category: "international_payment", createdAt: "2026-01-10T02:39:42.664Z" },
  { id: "cmjzbxhk100ksqg020ixdl4i7", shortcut: "Mukesh", content: "9953532428 - Mukesh ji\n\nBol dena Ketu ne number diya hai, will give better rates.", mediaUrl: null, mediaType: null, category: "caps_referral", createdAt: "2026-01-04T00:37:08.834Z" },
  { id: "cmjtb7evq009dlz02ckm2mmfe", shortcut: "140gsm", content: "This product is one time use and throw purpose.\n\nProduction time 60 days.\n\nSamples not available for this product.", mediaUrl: null, mediaType: null, category: "product_info", createdAt: "2025-12-30T19:30:15.255Z" },
  { id: "cmjs0vo9i02upl702wub61cnk", shortcut: "Custom", content: "Custom order ke liye inse baat kar lo, bol dena Ketu ne number diya hai, acche rates laga denge - https://wa.me/917808284808", mediaUrl: null, mediaType: null, category: "custom_order_referral", createdAt: "2025-12-29T21:53:25.206Z" },
  { id: "cmjqqnhzw01oyl7027uxl4u4q", shortcut: "Tiruppur", content: "Tiruppur only production unit sir.. Visit allowed in delhi warehouse only.", mediaUrl: null, mediaType: null, category: "factory_location", createdAt: "2025-12-29T00:19:21.500Z" },
  { id: "cmjo4hu740038l702kshn9zss", shortcut: "Notification", content: "Stock Alert ko enable kar lo website open karke - sale91.com\n\nStock aate hi notification aa jaayega.", mediaUrl: "https://files.sale91.com/templates/tpl_1766829210520_axcb0boyy.png", mediaType: "IMAGE", category: "stock_alerts", createdAt: "2025-12-27T04:23:33.473Z" },
  { id: "cmjnv9nhf00tfrs02wely0hpb", shortcut: "Sizechart", content: "Size chart - https://www.bulkplaintshirt.com/?q=SizeChart", mediaUrl: null, mediaType: null, category: "size_chart", createdAt: "2025-12-27T00:05:14.980Z" },
  { id: "cmjmw3wcr00aors02mcs2loay", shortcut: "Nepal", content: "Bhansar (custom)\n\nTshirt - 180 Nepali Rupee\nSweatshirt - 250 Nepali Rupee\nHoodie - 400 Nepali Rupee\n\nNo shipping charges upto Kathmandu", mediaUrl: null, mediaType: null, category: "nepal_pricing", createdAt: "2025-12-26T07:40:59.979Z" },
  { id: "cmjmrcr47002jrs0292c3n755", shortcut: "Bill", content: "Here order details - https://youtube.com/shorts/-Swb30-I7nA?feature=share", mediaUrl: "https://files.sale91.com/templates/tpl_1766746673638_hfn811qzb.jpg", mediaType: "IMAGE", category: "order_details_guide", createdAt: "2025-12-26T05:27:55.015Z" },
  { id: "cmjmp0psp012fpg02wb2fq2hq", shortcut: "welcome", content: "https://sale91.com/catalog\n\nCheck rates, color and buy\n\nNote: Launching Womens OS (Oversize), Womens RF (Regular Fit), Baby Rompers, AcidWash 6 colors in March.", mediaUrl: null, mediaType: null, category: "welcome_message", createdAt: "2025-12-26T04:22:34.201Z" },
  { id: "cmjlje35900appg027287v09t", shortcut: "Pickup", content: "Ketu - 7048954134\n\nF-120, Tshirt wala godown, Gujiar Chowk Khanpur, South Delhi, 110062\n\nhttps://maps.app.goo.gl/dGpvUxcMLg5MJmtS9", mediaUrl: null, mediaType: null, category: "warehouse_location", createdAt: "2025-12-25T08:57:14.157Z" },
  { id: "cmjliwzst009lpg02hqb400p1", shortcut: "Drive", content: "https://drive.google.com/drive/folders/1URpaQH-BI3YWcp5iql3DaaQJd2fMheQR\n\nDownload photos here", mediaUrl: null, mediaType: null, category: "general", createdAt: "2025-12-25T08:43:56.669Z" },
  { id: "cmjld35x60071pg02hoid7xlm", shortcut: "Calculator", content: "Shipping calculator - https://www.bulkplaintshirt.com/calc/shipping-calculator.html", mediaUrl: null, mediaType: null, category: "shipping_calculator", createdAt: "2025-12-25T06:00:46.843Z" },
  { id: "cmjl5a4ly00l7nk027478639s", shortcut: "Dropshipping", content: "Dropshipping option available on website sir - https://youtube.com/shorts/Z1zB5CIDpfA?si=7v9Lmqsb2Ml2ffn-", mediaUrl: "https://files.sale91.com/templates/tpl_1766649133520_tmgbu0fpk.jpg", mediaType: "IMAGE", category: "dropshipping_service", createdAt: "2025-12-25T02:22:14.806Z" },
  { id: "cmjl39qxa00g9nk0265puq3cv", shortcut: "Tracking", content: "Tracking aayi hogi aapko, jo number order ke time diya tha uspe. \n\nWebsite (sale91.com) pe bhi track ka button hota hai. https://youtube.com/shorts/-Swb30-I7nA?feature=share", mediaUrl: "https://files.sale91.com/templates/tpl_1766648615578_oz8bsqhy7.jpeg", mediaType: "IMAGE", category: "tracking_guide", createdAt: "2025-12-25T01:25:57.838Z" },
  { id: "cmjl10aoi00bqnk02b3aiv04a", shortcut: "Discount", content: "Extra 2rs per pc discount on website - sale91.com", mediaUrl: null, mediaType: null, category: "pricing_policy", createdAt: "2025-12-25T00:22:37.650Z" },
  { id: "cmjk44nf5000ynk02arc6ghfz", shortcut: "Website", content: "Order from website sir, instant will dispatch - sale91.com", mediaUrl: "https://files.sale91.com/templates/tpl_1766977760884_8p2rs1xnc.jpeg", mediaType: "IMAGE", category: "website_ordering", createdAt: "2025-12-24T09:02:13.457Z" },
  { id: "cmjjy09sx001erl023ak818j2", shortcut: "How", content: "How to order - https://youtube.com/shorts/F-zdRRSs370?feature=share", mediaUrl: null, mediaType: null, category: "ordering_guide", createdAt: "2025-12-24T06:10:51.489Z" },
  { id: "cmjjuec4h007rl702wt37ud2u", shortcut: "Printer", content: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726", mediaUrl: null, mediaType: null, category: "print_referral", createdAt: "2025-12-24T04:29:49.218Z" },
  { id: "cmjjlf4u2007jmo02o39b8pb2", shortcut: "Photos", content: "HD Photos - https://www.bulkplaintshirt.com/?q=HDphoto", mediaUrl: null, mediaType: null, category: "hd_photos", createdAt: "2025-12-24T00:18:29.882Z" },
  { id: "cmjjimrd4001ymo02teajwjqb", shortcut: "Catalog", content: "https://sale91.com/catalog\n\nCheck rates and color once sir", mediaUrl: null, mediaType: null, category: "catalog_link", createdAt: "2025-12-23T23:00:26.824Z" },
  { id: "cmjaa4pgq0014qi02vmuvyass", shortcut: "Payment", content: "1. Google Pay - 9336695049\n\n2. UPI - ownknitted@hdfcbank\n\n3. Bank Transfer -\nAccount Holder: OWN KNITTED BLANK WEARS\nAccount Number: 50200052063992\nIFSC: HDFC0000043\nBranch: SAKET\nAccount Type: CURRENT", mediaUrl: "https://files.sale91.com/templates/tpl_1765992148499_ii7usnjr2.png", mediaType: "IMAGE", category: "payment_methods", createdAt: "2025-12-17T11:52:32.042Z" },
  { id: "cmj44rxrn0002pm02y89l38uv", shortcut: "Address", content: "Sunday - 11am to 4pm\nRest days - 10am to 6pm\n\nhttps://maps.app.goo.gl/dGpvUxcMLg5MJmtS9 (Ask for TSHIRT WALA GODAM after reaching at location, call if required -7048954134)\n\nKindly visit for a limited duration of 5 to 10 minutes.", mediaUrl: "https://files.sale91.com/templates/tpl_1768706327686_exv5nielg.mp3", mediaType: "AUDIO", category: "business_hours_location", createdAt: "2025-12-13T04:36:01.139Z" },
]

// ===========================================
// Data: Catalog (from catalog repo data/catalog.js)
// ===========================================
const CATALOG_DATA = {
  categories: [
    {
      id: "oversized-tees", name: "Oversized Tees", icon: "\u{1F455}", color: "#2563eb",
      products: [
        { name: "Oversize 210gsm", nickname: "OS210", description: "Oversized Drop Shoulder 210gsm, Terry Cotton Loopknit Heavy Gauge, 100% Cotton Supercombed Red Lable Premium Fabric", rate: 175, samplePrice: 210, colors: ["Black","White","Lavender","Beige","Red","Sage Green","Brown","Off-white","Orange","Navy"], colorCodes: ["#222222","#FFFFFF","#C4B7D5","#D4C5A9","#DC143C","#9CAF88","#8B4513","#FAF5E4","#FF6B35","#1E3A5F"], sizes: ["S","M","L","XL","XXL"] },
        { name: "Oversize 240gsm", nickname: "OS240", description: "Oversized Drop-shoulder, 240gsm, Terry cotton/Loopknit Heavy Gauge, 100% Cotton Premium Quality Biowash Fabric", rate: 180, samplePrice: 222, colors: ["Black","White","Red","Maroon","Off-white","Beige","Lavender","Brown","Rose Pink","Charcoal","Army Green","Powder Blue"], colorCodes: ["#222222","#FFFFFF","#DC143C","#800020","#FAF5E4","#D4C5A9","#C4B7D5","#8B4513","#FF8FAB","#36454F","#4B5320","#B0D4F1"], sizes: ["XS","S","M","L","XL","XXL"] },
        { name: "Oversize 180gsm", nickname: "OS180", description: "Oversized Drop-shoulder 180gsm, 100% Cotton Supercombed Premium Quality Red Lable Fabric", rate: 165, samplePrice: 198, colors: ["Black","White"], colorCodes: ["#222222","#FFFFFF"], sizes: ["S","M","L","XL","XXL"] },
        { name: "Boxy Fit", nickname: "Boxy", description: "Boxy Fit Drop-shoulder Tshirt, 180gsm, 100% Cotton Supercombed Premium Quality Red Lable Fabric", rate: 175, samplePrice: 204, colors: ["Black","White"], colorCodes: ["#222222","#FFFFFF"], sizes: ["XS","S","M","L","XL","XXL"] },
        { name: "AcidWash Oversize", nickname: "Acid-OS", description: "AcidWash OS (Oversize Fit), 240gsm, 100% cotton Biowash French Terry Loopknit", rate: 220, samplePrice: 264, colors: ["Black"], colorCodes: ["#222222"], sizes: ["XS","S","M","L","XL","XXL"] },
      ]
    },
    {
      id: "roundneck-tees", name: "Round Neck Tees", icon: "\u{1F455}", color: "#16a34a",
      products: [
        { name: "True Biowash Round Neck", nickname: "True Bio", description: "Regular Fit, True Biowash Round neck, 180gsm, 100% Cotton Supercombed Premium Quality Red Lable Fabric", rate: 140, samplePrice: 174, colors: ["Black","White","Maroon","Navy","Mustard Yellow","Red","Bottle Green","Beige","Royal Blue","Lavender","Sky","Grey","Bhagwa"], colorCodes: ["#222222","#FFFFFF","#800020","#1E3A5F","#E6A817","#DC143C","#006A4E","#D4C5A9","#4169E1","#C4B7D5","#87CEEB","#808080","#FF6600"], sizes: ["36","38","40","42","44","46"] },
        { name: "Biowash Round Neck", nickname: "YL Bio", description: "Regular Fit, Biowash Round neck, 180gsm, 100% Cotton Premium Quality Fabric", rate: 130, samplePrice: 162, colors: ["Black","White","Navy","Red","Brown","Maroon","Charcoal","Off-white","Rose Pink"], colorCodes: ["#222222","#FFFFFF","#1E3A5F","#DC143C","#8B4513","#800020","#36454F","#FAF5E4","#FF8FAB"], sizes: ["36","38","40","42","44","46"] },
        { name: "Non Bio Round Neck", nickname: "NBio", description: "Non Bio Round neck, 180gsm, 88% Cotton, 12% Polyester", rate: 102, samplePrice: 129, colors: ["Black"], colorCodes: ["#222222"], sizes: ["36","38","40","42","44","46"] },
        { name: "Sublimation T-Shirt", nickname: "Sublimation", description: "Regular Fit Round neck, 200gsm, Cotton Feel Polyester Sublimation tshirt", rate: 115, samplePrice: 144, colors: ["White"], colorCodes: ["#FFFFFF"], sizes: ["36","38","40","42","44","46"] },
      ]
    },
    {
      id: "polo-tees", name: "Polo T-Shirts", icon: "\u{1F454}", color: "#7c3aed",
      products: [
        { name: "Premium Polo", nickname: "Bio Polo", description: "Most Premium Honeycomb Polo, 220gsm, 100% Cotton Supercombed Red Lable Fabric", rate: 220, samplePrice: 270, colors: ["Black","White","Navy","Maroon"], colorCodes: ["#222222","#FFFFFF","#1E3A5F","#800020"], sizes: ["36","38","40","42","44","46"] },
        { name: "Cotton Polo", nickname: "Polo", description: "Cotton Matty Polo neck, 220gsm, 88% Cotton, 12% Polyester", rate: 180, samplePrice: 222, colors: ["Black","White","Navy","Grey","Maroon","Charcoal"], colorCodes: ["#222222","#FFFFFF","#1E3A5F","#808080","#800020","#36454F"], sizes: ["36","38","40","42","44","46"] },
      ]
    },
    {
      id: "hoodies", name: "Hoodies", icon: "\u{1F9E5}", color: "#dc2626",
      products: [
        { name: "Zip Hoodie", nickname: "Zipper", description: "Zipper Hoodie, 320gsm, Cotton Brushed Loopknit, 88% cotton, 12% polyester", rate: 325, samplePrice: 390, colors: ["Black"], colorCodes: ["#222222"], sizes: ["S","M","L","XL","XXL"] },
        { name: "Hoodie 320gsm (Black)", nickname: "Hood320-1", description: "Non-zipper Hoodie, 320gsm, Cotton Brushed Loopknit, 88% cotton, 12% polyester", rate: 295, samplePrice: 366, colors: ["Black"], colorCodes: ["#222222"], sizes: ["S","M","L","XL","XXL"] },
        { name: "Hoodie 320gsm", nickname: "Hood320-2", description: "Non-zipper Hoodie, 320gsm, Cotton Brushed Loopknit, 88% cotton, 12% polyester", rate: 325, samplePrice: 402, colors: ["White","Navy","Army Green","Off-white","Maroon","Grey","Red"], colorCodes: ["#FFFFFF","#1E3A5F","#4B5320","#FAF5E4","#800020","#808080","#DC143C"], sizes: ["S","M","L","XL","XXL"] },
        { name: "Dropshoulder Hoodie 430gsm", nickname: "Hood430", description: "Most Heavy Non-zipper Dropshoulder Hoodie, 430gsm, Cotton Brushed Loopknit, 88% cotton, 12% polyester", rate: 380, samplePrice: 468, colors: ["Black"], colorCodes: ["#222222"], sizes: ["S","M","L","XL","XXL"] },
        { name: "Hoodie 430gsm", nickname: "Hood430-2", description: "Most Heavy Non-zipper Dropshoulder Hoodie, 430gsm, Cotton Brushed Loopknit, 88% cotton, 12% polyester", rate: 418, samplePrice: 502, colors: ["Navy","White","Off-white"], colorCodes: ["#1E3A5F","#FFFFFF","#FAF5E4"], sizes: ["S","M","L","XL","XXL"] },
      ]
    },
    {
      id: "sweatshirts", name: "Sweatshirts & Jackets", icon: "\u{1F9E5}", color: "#ea580c",
      products: [
        { name: "Sweatshirt", nickname: "Sweatshirt", description: "Sweatshirt, 320gsm, Cotton Brushed Loopknit, 88% cotton, 12% polyester", rate: 225, samplePrice: 276, colors: ["Black","Navy","Grey","Army Green"], colorCodes: ["#222222","#1E3A5F","#808080","#4B5320"], sizes: ["S","M","L","XL","XXL"] },
        { name: "Sweatshirt 2", nickname: "Sweatshirt-2", description: "Sweatshirt, 320gsm, Cotton Brushed Loopknit, 88% cotton, 12% polyester", rate: 240, samplePrice: 288, colors: ["Maroon","White","Off-white"], colorCodes: ["#800020","#FFFFFF","#FAF5E4"], sizes: ["S","M","L","XL","XXL"] },
        { name: "Varsity Jacket", nickname: "Varsity", description: "Varsity Jacket, 320gsm, Cotton Brushed Loopknit, White Sleeve/Black Body, 88% cotton, 12% polyester", rate: 335, samplePrice: 402, colors: ["Black"], colorCodes: ["#222222"], sizes: ["XS","S","M","L","XL","XXL"] },
      ]
    },
    {
      id: "kids-and-more", name: "Kids & Bottomwear", icon: "\u{1F476}", color: "#f59e0b",
      products: [
        { name: "Kids Round Neck", nickname: "Kids", description: "True Biowash Kids Round neck, 180gsm, 100% Cotton Supercombed Premium Quality Red Lable Fabric", rate: 110, samplePrice: 144, colors: ["Black","White","Red","Baby Pink","Mustard Yellow"], colorCodes: ["#222222","#FFFFFF","#DC143C","#FFB6C1","#E6A817"], sizes: ["20","22","24","26","28","30","32","34"] },
        { name: "Shorts", nickname: "Shorts", description: "240gsm, Terry cotton/Loopknit Heavy Gauge, 100% Cotton Supercombed Premium Quality Red Lable Fabric, (Zipper Left and Right pocket, 1 back pocket)", rate: 205, samplePrice: 246, colors: ["Black","Off-white","Lavender","Beige"], colorCodes: ["#222222","#FAF5E4","#C4B7D5","#D4C5A9"], sizes: ["XS","S","M","L","XL"] },
      ]
    }
  ]
}

// ===========================================
// Data: Style Pairs (from style-pairs-final.txt)
// Parsed into structured Q&A pairs
// ===========================================
const STYLE_PAIRS_RAW = `BUYER: Any minimum quantity
OM: Any quantity you can buy

BUYER: Kya aap custom order bhi lete ho?
OM: Custom order we dont take sir. Ready stock mai hi sell karte hai

BUYER: On order bna sakte ho?
OM: On order we dont make sir

BUYER: Custom order le sakte ho?
OM: Custom order we dont make

BUYER: Can you make custom design?
OM: We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726

BUYER: Printing bhi hoti hai kya?
OM: We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726

BUYER: Print karwa sakte hai?
OM: We sell plain only. Printing ke liye inse baat kar lo - wa.me/918810256726

BUYER: Kya aap printing bhi karte ho?
OM: We sell plain tshirts only sir. Printing ke liye printer se baat kar lo

BUYER: Do you do embroidery?
OM: We sell plain tshirts only. You can talk to him for Embroidary - Wa.me/919266306545

BUYER: Embroidery karte ho?
OM: We sell plain tshirts only. You can talk to him for Embroidary - Wa.me/919266306545

BUYER: Kya return policy hai?
OM: Return, replacement not allowed sir

BUYER: Return ho sakta hai?
OM: No return sir

BUYER: Agar defective aaya toh?
OM: If there is genuine factory defect then we will consider

BUYER: COD available hai?
OM: Only prepaid we do sir

BUYER: Cash on delivery hota hai?
OM: Only prepaid sir

BUYER: Payment kaise karu?
OM: Website se order karo sir - sale91.com. Online payment prepaid only

BUYER: UPI se payment ho jayega?
OM: Yes sir, website pe UPI option hai

BUYER: Shipping charges kitna hai?
OM: Shipping calculator use karo - https://www.bulkplaintshirt.com/calc/shipping-calculator.html

BUYER: Delivery kitne din mai hogi?
OM: 4 to 5 days sir courier se

BUYER: Kab tak aa jayega?
OM: 4-5 working days normally

BUYER: Which courier do you use?
OM: Delhivery or Blue Dart mostly

BUYER: Train se bhej sakte ho?
OM: Yes train shipping available. Watch this - https://youtube.com/shorts/hwetf1NFVME

BUYER: Wholesale rate kya hai?
OM: Website pe sab rates hai sir - sale91.com/catalog. 10 pcs se bulk rate

BUYER: Bulk rate kya hai?
OM: 10 pcs se bulk rate start hota hai sir. Check website - sale91.com

BUYER: 10 piece se kam le sakte hai?
OM: Yes sir any quantity. Sample rate lagega

BUYER: Sample rate kya hai?
OM: Website pe sample rate mentioned hai sir - sale91.com/catalog

BUYER: Website kya hai?
OM: sale91.com sir

BUYER: Website se order kaise karu?
OM: How to order - https://youtube.com/shorts/F-zdRRSs370?feature=share

BUYER: Website pe discount milega?
OM: Extra 2rs per pc discount on website - sale91.com

BUYER: GST number add kaise karu?
OM: Add GST number to our website - https://youtube.com/shorts/LoLw9InfKNc?feature=share

BUYER: GST bill milega?
OM: Yes sir, GST invoice milega. Website pe GST number add kar lo

BUYER: Factory kahan hai?
OM: Tiruppur only production unit sir.. Visit allowed in delhi warehouse only

BUYER: Visit kar sakte hai?
OM: Delhi warehouse visit kar sakte ho sir

BUYER: Delhi godown kahan hai?
OM: F-120, Tshirt wala godown, Gujiar Chowk Khanpur, South Delhi, 110062

BUYER: Kab visit kar sakte hai?
OM: Sunday - 11am to 4pm. Rest days - 10am to 6pm

BUYER: Size chart kahan hai?
OM: Size chart - https://www.bulkplaintshirt.com/?q=SizeChart

BUYER: Photos kahan milenge?
OM: HD Photos - https://www.bulkplaintshirt.com/?q=HDphoto

BUYER: HD photos chahiye
OM: HD Photos - https://www.bulkplaintshirt.com/?q=HDphoto

BUYER: Stock available hai?
OM: Website pe check kar lo sir - sale91.com. Jo available hai wo dikha dega

BUYER: Out of stock kab aayega?
OM: Stock Alert ko enable kar lo website open karke - sale91.com. Stock aate hi notification aa jaayega

BUYER: Nepal mai ship karte ho?
OM: Yes sir Nepal delivery available. Bhansar custom extra lagta hai

BUYER: Nepal shipping charges?
OM: Tshirt - 180 Nepali Rupee, Sweatshirt - 250 Nepali Rupee, Hoodie - 400 Nepali Rupee bhansar. No shipping charges upto Kathmandu

BUYER: Bags kahan milenge?
OM: Bags from Mumbai - wa.me/917066316315, bol dena Ketu ne number diya hai

BUYER: Shirts milte hai?
OM: Shirts ke liye inse baat karlo - wa.me/919953321193, bol dena Ketu ne number diya hai

BUYER: Cap supplier hai?
OM: 9953532428 - Mukesh ji. Bol dena Ketu ne number diya hai

BUYER: Machine kahan se lu?
OM: wa.me/919350848723 - Machine ke liye inse baat kar lo. Bol dena Ketu ne number diya hai. Website - https://boomenterprise.in

BUYER: Dropshipping available hai?
OM: Dropshipping option available on website sir - https://youtube.com/shorts/Z1zB5CIDpfA

BUYER: Tracking kahan check karu?
OM: Website (sale91.com) pe track ka button hota hai

BUYER: Order ka status kaise check karu?
OM: Website pe login karo same mail se. Everything will sync

BUYER: Account kaise banau?
OM: Click create a new account >> Use same mail which you used while ordering >> Enter any password and click create account

BUYER: 210gsm aur 240gsm mai kya farak hai?
OM: 240gsm thoda heavy hota hai sir. Dono oversized hai

BUYER: Biowash aur non-bio mai kya farak hai?
OM: True Bio Rneck - double biowash. Bio Rneck - single biowash. Non bio - no biowash

BUYER: 140gsm kaisa hai?
OM: This product is one time use and throw purpose. Production time 60 days. Samples not available

BUYER: Printer se kaise coordinate karu?
OM: How do I coordinate with printer - https://youtube.com/shorts/Vwg-lChShx4

BUYER: PayPal se payment ho jayega?
OM: https://www.paypal.me/ankitgupta780 - You can pay here and share screenshot

BUYER: Bill download kaise karu?
OM: Here order details - https://youtube.com/shorts/-Swb30-I7nA?feature=share

BUYER: Google Drive photos link?
OM: https://drive.google.com/drive/folders/1URpaQH-BI3YWcp5iql3DaaQJd2fMheQR - Download photos here

BUYER: Women's tshirt hai?
OM: Launching Womens OS (Oversize), Womens RF (Regular Fit), Baby Rompers, AcidWash 6 colors in March

BUYER: New products kab aayenge?
OM: Launching new products in March sir. Women's range and more acid wash colors

BUYER: Catalog link?
OM: https://sale91.com/catalog - Check rates and color once sir`

function parseStylePairs(raw) {
  const pairs = []
  const lines = raw.trim().split('\n')
  let buyer = '', om = ''
  for (const line of lines) {
    if (line.startsWith('BUYER: ')) {
      if (buyer && om) pairs.push({ buyer, om })
      buyer = line.replace('BUYER: ', '')
      om = ''
    } else if (line.startsWith('OM: ')) {
      om = line.replace('OM: ', '')
    }
  }
  if (buyer && om) pairs.push({ buyer, om })
  return pairs
}

const STYLE_PAIRS = parseStylePairs(STYLE_PAIRS_RAW)

// ===========================================
// App Component
// ===========================================

function App() {
  const [tab, setTab] = useState('catalog')
  const [replySearch, setReplySearch] = useState('')
  const [catalogSearch, setCatalogSearch] = useState('')
  const [pairSearch, setPairSearch] = useState('')
  const [expandedCategory, setExpandedCategory] = useState(null)

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <h1 style={styles.title}>Sale91 — Knowledge Base</h1>
      </header>

      {/* 3 Tabs */}
      <nav style={styles.tabs}>
        {[
          { id: 'catalog', label: 'Catalog' },
          { id: 'reply', label: 'Reply Templates' },
          { id: 'style', label: 'Style Pairs' },
        ].map(t => (
          <button
            key={t.id}
            style={{ ...styles.tab, ...(tab === t.id ? styles.activeTab : {}) }}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main style={styles.main}>
        {tab === 'catalog' && (
          <CatalogTab search={catalogSearch} setSearch={setCatalogSearch} expandedCategory={expandedCategory} setExpandedCategory={setExpandedCategory} />
        )}
        {tab === 'reply' && (
          <ReplyTab search={replySearch} setSearch={setReplySearch} />
        )}
        {tab === 'style' && (
          <StylePairsTab search={pairSearch} setSearch={setPairSearch} />
        )}
      </main>
    </div>
  )
}

// ===========================================
// Catalog Tab
// ===========================================
function CatalogTab({ search, setSearch, expandedCategory, setExpandedCategory }) {
  const totalProducts = CATALOG_DATA.categories.reduce((sum, cat) => sum + cat.products.length, 0)

  const filteredCategories = CATALOG_DATA.categories.map(cat => ({
    ...cat,
    products: cat.products.filter(p =>
      !search || p.name.toLowerCase().includes(search.toLowerCase()) || p.nickname.toLowerCase().includes(search.toLowerCase()) || p.description.toLowerCase().includes(search.toLowerCase())
    )
  })).filter(cat => cat.products.length > 0)

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h2 style={styles.sectionTitle}>Product Catalog ({totalProducts} products)</h2>
      </div>

      <div style={{ marginBottom: '16px' }}>
        <input
          type="text"
          placeholder="Search products..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={styles.searchInput}
        />
      </div>

      {filteredCategories.map(cat => (
        <div key={cat.id} style={styles.categorySection}>
          <div
            style={styles.categoryHeader}
            onClick={() => setExpandedCategory(expandedCategory === cat.id ? null : cat.id)}
          >
            <span style={{ fontSize: '16px', fontWeight: '600', color: '#f8fafc' }}>
              {cat.icon} {cat.name} ({cat.products.length})
            </span>
            <span style={{ color: '#64748b' }}>{expandedCategory === cat.id ? '\u25BC' : '\u25B6'}</span>
          </div>

          {expandedCategory === cat.id && (
            <div style={{ padding: '0 16px 16px' }}>
              {cat.products.map((p, i) => (
                <div key={i} style={styles.productCard}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '8px' }}>
                    <div>
                      <div style={{ fontSize: '15px', fontWeight: '600', color: '#f8fafc' }}>{p.name}</div>
                      <div style={{ fontSize: '12px', color: '#64748b', marginTop: '2px' }}>{p.nickname} | {cat.name}</div>
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <span style={{ ...styles.priceBadge, background: '#14532d' }}>Bulk \u20B9{p.rate}</span>
                      <span style={{ ...styles.priceBadge, background: '#854d0e' }}>Sample \u20B9{p.samplePrice}</span>
                    </div>
                  </div>
                  <div style={{ fontSize: '13px', color: '#94a3b8', marginTop: '8px' }}>{p.description}</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '8px' }}>
                    {p.colors.map((c, ci) => (
                      <span key={ci} style={{ ...styles.colorChip, borderLeft: `3px solid ${p.colorCodes[ci]}` }}>{c}</span>
                    ))}
                  </div>
                  <div style={{ fontSize: '12px', color: '#64748b', marginTop: '6px' }}>
                    Sizes: {p.sizes.join(', ')}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ===========================================
// Reply Templates Tab
// ===========================================
function ReplyTab({ search, setSearch }) {
  const filtered = REPLY_TEMPLATES.filter(t =>
    !search ||
    t.shortcut.toLowerCase().includes(search.toLowerCase()) ||
    t.content.toLowerCase().includes(search.toLowerCase()) ||
    t.category.toLowerCase().includes(search.toLowerCase())
  )

  const categories = [...new Set(REPLY_TEMPLATES.map(t => t.category))].sort()

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h2 style={styles.sectionTitle}>Saved Reply Templates ({REPLY_TEMPLATES.length})</h2>
      </div>

      <div style={{ marginBottom: '16px' }}>
        <input
          type="text"
          placeholder="Search replies by shortcut, content, or category..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={styles.searchInput}
        />
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '16px' }}>
        <button
          style={{ ...styles.filterChip, ...(search === '' ? styles.filterChipActive : {}) }}
          onClick={() => setSearch('')}
        >
          All ({REPLY_TEMPLATES.length})
        </button>
        {categories.map(cat => {
          const count = REPLY_TEMPLATES.filter(t => t.category === cat).length
          return (
            <button
              key={cat}
              style={{ ...styles.filterChip, ...(search === cat ? styles.filterChipActive : {}) }}
              onClick={() => setSearch(search === cat ? '' : cat)}
            >
              {cat.replace(/_/g, ' ')} ({count})
            </button>
          )
        })}
      </div>

      {filtered.map(t => (
        <div key={t.id} style={styles.replyCard}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={styles.shortcutBadge}>/{t.shortcut}</span>
              {t.mediaType && (
                <span style={styles.mediaBadge}>{t.mediaType}</span>
              )}
            </div>
            <span style={{ fontSize: '11px', color: '#475569' }}>
              {new Date(t.createdAt).toLocaleDateString('en-IN')}
            </span>
          </div>
          <div style={{ fontSize: '13px', color: '#cbd5e1', whiteSpace: 'pre-wrap', lineHeight: '1.5' }}>
            {t.content}
          </div>
          <div style={{ marginTop: '6px' }}>
            <span style={{ fontSize: '11px', color: '#64748b', background: '#1e293b', padding: '2px 8px', borderRadius: '3px' }}>
              {t.category.replace(/_/g, ' ')}
            </span>
          </div>
        </div>
      ))}

      {filtered.length === 0 && <p style={styles.empty}>No matching reply templates found</p>}
    </div>
  )
}

// ===========================================
// Style Pairs Tab
// ===========================================
function StylePairsTab({ search, setSearch }) {
  const filtered = STYLE_PAIRS.filter(p =>
    !search ||
    p.buyer.toLowerCase().includes(search.toLowerCase()) ||
    p.om.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h2 style={styles.sectionTitle}>Style Pairs ({STYLE_PAIRS.length} pairs)</h2>
      </div>

      <p style={{ color: '#94a3b8', fontSize: '13px', marginBottom: '16px' }}>
        Permanent buyer question &rarr; Om reply pairs. These define how Ketu should respond to common queries.
      </p>

      <div style={{ marginBottom: '16px' }}>
        <input
          type="text"
          placeholder="Search style pairs..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={styles.searchInput}
        />
      </div>

      {filtered.map((p, i) => (
        <div key={i} style={styles.pairCard}>
          <div style={{ fontSize: '13px', marginBottom: '6px' }}>
            <span style={{ color: '#f87171', fontWeight: '600' }}>Buyer:</span>{' '}
            <span style={{ color: '#e2e8f0' }}>{p.buyer}</span>
          </div>
          <div style={{ fontSize: '13px' }}>
            <span style={{ color: '#22c55e', fontWeight: '600' }}>Om:</span>{' '}
            <span style={{ color: '#86efac' }}>{p.om}</span>
          </div>
        </div>
      ))}

      {filtered.length === 0 && <p style={styles.empty}>No matching style pairs found</p>}
    </div>
  )
}

// ===========================================
// Styles
// ===========================================
const styles = {
  container: { fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', maxWidth: '1200px', margin: '0 auto', padding: '16px', background: '#0f172a', color: '#e2e8f0', minHeight: '100vh' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 0', borderBottom: '1px solid #1e293b' },
  title: { fontSize: '20px', fontWeight: '700', color: '#f8fafc', margin: 0 },
  tabs: { display: 'flex', gap: '4px', marginTop: '16px', borderBottom: '1px solid #1e293b', paddingBottom: '0' },
  tab: { padding: '12px 24px', border: 'none', background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: '15px', fontWeight: '500', borderBottom: '2px solid transparent' },
  activeTab: { color: '#3b82f6', borderBottom: '2px solid #3b82f6', fontWeight: '600' },
  main: { marginTop: '20px' },
  empty: { color: '#64748b', textAlign: 'center', padding: '40px' },
  sectionTitle: { fontSize: '18px', fontWeight: '600', color: '#f8fafc', margin: 0 },
  searchInput: { width: '100%', padding: '10px 14px', border: '1px solid #334155', borderRadius: '8px', background: '#1e293b', color: '#f8fafc', fontSize: '14px', boxSizing: 'border-box', outline: 'none' },

  // Catalog
  categorySection: { background: '#1e293b', borderRadius: '8px', marginBottom: '12px', overflow: 'hidden' },
  categoryHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px', cursor: 'pointer', userSelect: 'none' },
  productCard: { background: '#0f172a', padding: '14px', borderRadius: '8px', marginBottom: '8px', border: '1px solid #334155' },
  priceBadge: { padding: '3px 10px', borderRadius: '4px', color: '#fff', fontSize: '12px', fontWeight: '600' },
  colorChip: { padding: '2px 8px', borderRadius: '3px', background: '#334155', color: '#cbd5e1', fontSize: '11px' },

  // Reply
  replyCard: { background: '#1e293b', padding: '14px', borderRadius: '8px', marginBottom: '8px' },
  shortcutBadge: { padding: '2px 10px', borderRadius: '4px', background: '#3b82f6', color: '#fff', fontSize: '12px', fontWeight: '600' },
  mediaBadge: { padding: '2px 8px', borderRadius: '3px', background: '#7c3aed', color: '#fff', fontSize: '10px', fontWeight: '600' },
  filterChip: { padding: '4px 10px', borderRadius: '12px', border: '1px solid #334155', background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: '11px' },
  filterChipActive: { background: '#3b82f6', color: '#fff', border: '1px solid #3b82f6' },

  // Style Pairs
  pairCard: { background: '#1e293b', padding: '12px 14px', borderRadius: '8px', marginBottom: '6px' },
}

export default App
