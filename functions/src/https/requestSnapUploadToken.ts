import { HttpsError, onCall }       from "firebase-functions/v2/https";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { logger }                   from "firebase-functions";

const requestSnapUploadToken = onCall(async request => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "Unauthenticated.");
    }

    const ref = await getFirestore().collection("uploadTokens").add({
        owner: request.auth.uid,
        validUntil: FieldValue.serverTimestamp()
    });

    logger.info(`Created SNAP_UPLOAD_TOKEN ${ ref.id } for user ${ request.auth.uid }.`);
    return { token: ref.id };
});

export default requestSnapUploadToken;
