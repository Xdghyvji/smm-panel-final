// FILE: netlify/functions/handleWorkupPayIPN.js

const admin = require('firebase-admin');
const crypto = require('crypto');

// Initialize Firebase Admin SDK - This block should only appear once per file.
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    }),
  });
}
const db = admin.firestore();

exports.handler = async (event, context) => {
    console.log('handleWorkupPayIPN function invoked.'); // Initial log
    console.log('handleWorkupPayIPN received raw event body:', event.body);
    console.log('handleWorkupPayIPN received event headers:', event.headers);

  if (event.httpMethod !== 'POST') {
        console.log('Method not allowed, returning 405.');
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Parse URL-encoded form data
  const params = new URLSearchParams(event.body);

  const status = params.get('status');
  const signature = params.get('signature');
  const identifier = params.get('identifier');

    // --- Store original string amount for signature validation ---
    const rawAmountString = params.get('data[amount]');

    // --- CORRECTED DATA PARSING (for internal use after validation) ---
    const data = {
        payment_trx: params.get('data[payment_trx]'),
        amount: parseFloat(rawAmountString), // Convert to float for later use
        payment_type: params.get('data[payment_type]'),
        charge: params.get('data[charge]'),
        currency: {
            code: params.get('data[currency][code]'),
            symbol: params.get('data[currency][symbol]')
        },
        // Add any other 'data[key]' parameters you expect from Workup Pay
    };

    console.log('Parsed data object (for internal use):', data); // Log the parsed data

  // Early exit if essential top-level parameters or critical data fields are missing
  if (!status || !signature || !identifier || isNaN(data.amount) || rawAmountString === null || data.payment_trx === null) {
    console.error('IPN Error: Missing required parameters or invalid data amount.');
    return { statusCode: 400, body: 'Missing parameters.' };
  }
  
  // --- Signature Validation ---
  // Use the original string amount for signature generation to match Workup Pay's hash
  const customKey = `${rawAmountString}${identifier}`; // Use rawAmountString here
  const mySignature = crypto
    .createHmac('sha256', process.env.WORKUP_PAY_SECRET_KEY)
    .update(customKey)
    .digest('hex')
    .toUpperCase();

    // --- ADDED DEBUGGING LOGS FOR SIGNATURE ---
    console.log('Signature received from Workup Pay:', signature);
    console.log('Calculated customKey for hash:', customKey);
    console.log('Calculated mySignature:', mySignature);


  if (signature !== mySignature) {
    console.error('IPN Validation Failed: Signatures do not match.');
    return { statusCode: 400, body: 'Invalid signature.' };
  }
    console.log('Signature validated successfully.'); // Log on success

  // --- Find user and transaction directly via lookup document ---
  const ipnLookupRef = db.collection('ipn_lookups').doc(identifier);
  const ipnLookupDoc = await ipnLookupRef.get();

  if (!ipnLookupDoc.exists) {
     console.error(`IPN Error: Could not find lookup for identifier: ${identifier}`);
     return { statusCode: 404, body: 'Transaction lookup not found.' };
  }

  const { userId } = ipnLookupDoc.data();
  const userRef = db.collection("users").doc(userId);
  const transactionRef = userRef.collection("transactions").doc(identifier);
    
  try {
    await db.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      console.log('Inside transaction: userDoc retrieved:', userDoc); // ADDED LOG
      console.log('Type of userDoc:', typeof userDoc); // Should be 'object'
      console.log('userDoc.exists (property):', userDoc.exists); // Should be boolean
      console.log('Type of userDoc.exists (property):', typeof userDoc.exists); // Should be 'boolean'
      console.log('userDoc.exists (method):', typeof userDoc.exists === 'function' ? 'function' : 'not a function'); // Should be 'function' on DocumentSnapshot, but property is safer.

      const transactionDoc = await t.get(transactionRef);
      console.log('Inside transaction: transactionDoc retrieved:', transactionDoc); // ADDED LOG
      console.log('Type of transactionDoc:', typeof transactionDoc);
      console.log('transactionDoc.exists (property):', transactionDoc.exists);
      console.log('Type of transactionDoc.exists (property):', typeof transactionDoc.exists);
      console.log('transactionDoc.exists (method):', typeof transactionDoc.exists === 'function' ? 'function' : 'not a function');

      // --- FIX: Changed from .exists() to .exists (property access) ---
      if (!userDoc.exists || !transactionDoc.exists) {
        throw new Error("User or Transaction document not found.");
      }
      
      if (transactionDoc.data().status === 'completed') {
          console.log(`IPN for ${identifier} already processed.`);
          return;
      }
      
      if (status === "success") {
        const amountToAdd = data.amount; // Use the parsed float amount
        const newBalance = (userDoc.data().balance || 0) + amountToAdd;
        t.update(userRef, { balance: newBalance });
        t.update(transactionRef, {
            status: 'completed',
            gatewayTransactionId: data.payment_trx, // Use data.payment_trx
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        // --- Handle referral commission logic ---
        const userData = userDoc.data();
        if (userData.referredBy) {
            const referrerRef = db.collection("users").doc(userData.referredBy);
            const commissionRate = 0.05; // 5%
            const commissionAmount = amountToAdd * commissionRate;

            const referrerDoc = await t.get(referrerRef);
            if (referrerDoc.exists) { // Changed from .exists() to .exists
                 const currentCommission = referrerDoc.data().commissionBalance || 0;
                 t.update(referrerRef, { commissionBalance: currentCommission + commissionAmount });

                 const commissionLogRef = db.collection("users").doc(userData.referredBy).collection("commissions").doc();
                 t.set(commissionLogRef, {
                    amount: commissionAmount,
                    fromUserId: userId,
                    fromUserEmail: userData.email,
                    transactionId: identifier,
                    createdAt: admin.firestore.FieldValue.serverTimestamp()
                 });

                 console.log(`Awarded ${commissionAmount} commission to referrer ${userData.referredBy}`);
            } else {
                console.warn(`Referrer ${userData.referredBy} not found for commission.`);
            }
        }
      } else { // Handle non-success statuses
        console.log(`Payment status is ${status} for identifier ${identifier}. Marking as ${status}.`);
        t.update(transactionRef, {
            status: status,
            gatewayTransactionId: data.payment_trx, // Use data.payment_trx
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            failureReason: `Workup Pay status: ${status}`
        });
      }
    }); // Closes db.runTransaction(async (t) => { ... })
    console.log(`Transaction for ${identifier} completed successfully.`);
    return { statusCode: 200, body: 'IPN processed successfully.' };
  } catch (error) {
    console.error('Firestore Transaction Failed:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message || 'An internal error occurred.' }),
    };
  }
}; // Closes exports.handler = async (event, context) => { ... }
