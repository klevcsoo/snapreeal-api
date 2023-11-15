import { cert, initializeApp } from "firebase-admin/app";
import { createSnap, requestSnapUploadToken } from "./https";
import { onDiaryDeleted, onSnapDeleted } from "./firestore";

initializeApp({
    credential: cert(require("../service-account.json")),
    storageBucket: "snapreeal.appspot.com"
});

exports.requestSnapUploadToken = requestSnapUploadToken;
exports.createSnap = createSnap;

exports.onDiaryDeleted = onDiaryDeleted;
exports.onSnapDeleted = onSnapDeleted;
