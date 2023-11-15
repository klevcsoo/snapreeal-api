import { onDocumentDeleted } from "firebase-functions/v2/firestore";
import { getStorage } from "firebase-admin/storage";
import { logger } from "firebase-functions";

const onDiaryDeleted = onDocumentDeleted("users/{userId}/diaries/{diaryId}", async event => {
    const files = (await getStorage().bucket().getFiles({
        prefix: `diary-media/${ event.params.diaryId }`
    }))[0];

    for (const file of files) {
        try {
            await file.delete();
            logger.info("Deleted media related to diary:", file.id);
        } catch (e) {
            logger.error(e);
        }
    }
});

export default onDiaryDeleted;
