import { onDocumentDeleted } from "firebase-functions/v2/firestore";
import { getStorage } from "firebase-admin/storage";
import { logger } from "firebase-functions";

const onSnapDeleted = onDocumentDeleted("users/{userId}/diaries/{diaryId}/snaps/{snapId}",
    async event => {
        const files = (await getStorage().bucket().getFiles({
            prefix: `diary-media/${ event.params.diaryId }/${ event.params.snapId }`
        }))[0];

        for (const file of files) {
            try {
                await file.delete();
                logger.info("Deleted media related to snap:", file.name);
            } catch (e) {
                logger.error(e);
            }
        }
    });

export default onSnapDeleted;
