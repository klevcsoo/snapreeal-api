import { HttpsError, onCall } from "firebase-functions/v2/https";
import { getDownloadURL, getStorage } from "firebase-admin/storage";
import { logger } from "firebase-functions";
import axios from "axios";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { path as ffmpegPath, version as ffmpegVersion } from "@ffmpeg-installer/ffmpeg";
import { getFirestore } from "firebase-admin/firestore";
import * as sharp from "sharp";
import ffmpeg = require("fluent-ffmpeg");

interface RequestType {
    diaryId: string;
    uploadToken: string;
    date: SnapDate;
    mediaEditOptions: {
        filename: string;
        start: number;
        length: number;
    };
}

interface SnapType {
    date: SnapDate;
    mediaLength: number;
    videoUrl: string;
    thumbnailUrl: string;
    isThumbnailDark: boolean;
}

type SnapDate = `${ number }-${ number }-${ number }`

const IS_DEV_ENV = process.env.FUNCTIONS_EMULATOR === "true";
if (IS_DEV_ENV) {
    logger.info("Developer environment.");
}

const MEDIA_EXPORT_CONFIG = {
    VIDEO_FILENAME: "export.webm",
    VIDEO_SIZE: "1080x?",
    VIDEO_ASPECT: "9:16",
    VIDEO_VIDEO_CODEC: "vp8", // unused
    VIDEO_AUDIO_CODEC: "libogg", // unused
    VIDEO_CONTAINER_FORMAT: "webm",
    VIDEO_OUTPUT_OPTIONS: [ "-cpu-used 5", "-deadline realtime" ],
    THUMBNAIL_FILENAME: "thumbnail.png",
    THUMBNAIL_SIZE: "512x?"
} as const;

ffmpeg.setFfmpegPath(ffmpegPath);

const createSnap = onCall<RequestType>({
    timeoutSeconds: 120,
    memory: "1GiB"
}, async request => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "Unauthenticated.");
    }

    const storageBucket = getStorage().bucket();
    const { uploadToken, mediaEditOptions, date, diaryId } = request.data;

    // creating working folder
    const workingDir = path.join(os.tmpdir(), `temp_upload_${ uploadToken }`);
    fs.mkdirSync(workingDir, { recursive: true });

    const cleanup = async () => {
        if (fs.existsSync(workingDir)) {
            fs.rmSync(workingDir, { recursive: true, force: true });
            logger.info("Working temp folder cleaned");
        }

        await getFirestore().collection("uploadTokens").doc(uploadToken).delete();
    };

    // generating download URL for temporary video file
    const tempFileStoragePath = `temp/${ uploadToken }/${ mediaEditOptions.filename }`;
    const ref = storageBucket.file(tempFileStoragePath);
    const downloadUrl = await getDownloadURL(ref);
    logger.info(`Download URL generated for file ${ tempFileStoragePath }:`, downloadUrl);

    // downloading temp video file
    const tempFilepath = path.join(workingDir, mediaEditOptions.filename);
    ;(await axios.get<fs.ReadStream>(downloadUrl, {
        method: "GET",
        responseType: "stream"
    })).data.pipe(fs.createWriteStream(tempFilepath));
    logger.info("Downloaded file to:", tempFilepath);

    // building ffmpeg commands
    logger.info(`Processing video file... (ffmpeg ${ ffmpegVersion } ${ ffmpegPath })`);
    const mediaDuration = Math.max(1, Math.min(mediaEditOptions.length, 5));
    const baseCommand = ffmpeg().input(tempFilepath)
        .setStartTime(mediaEditOptions.start / 1000)
        .withDuration(mediaDuration);

    // create video-processing promise
    const processVideoPromise = new Promise<string>(resolve => {
        const filepath = path.join(workingDir, MEDIA_EXPORT_CONFIG.VIDEO_FILENAME);
        const progressEnd = (mediaEditOptions.start + mediaEditOptions.length);
        let lastProgress = 0;

        baseCommand.clone()
            .withSize(MEDIA_EXPORT_CONFIG.VIDEO_SIZE)
            .withAspectRatio(MEDIA_EXPORT_CONFIG.VIDEO_ASPECT)
            // .withVideoCodec(MEDIA_EXPORT_CONFIG.VIDEO_VIDEO_CODEC)
            // .withAudioCodec(MEDIA_EXPORT_CONFIG.VIDEO_AUDIO_CODEC)
            .withOutputFormat(MEDIA_EXPORT_CONFIG.VIDEO_CONTAINER_FORMAT)
            .withOutputOptions(Array.from(MEDIA_EXPORT_CONFIG.VIDEO_OUTPUT_OPTIONS))
            .on("error", err => {
                logger.error(err);
                cleanup();
                throw new HttpsError("internal", "Failed to process video on server.");
            })
            .on("end", () => {
                logger.info("Video processing finished. Path: ", filepath);
                resolve(filepath);
            })
            .on("progress", (value) => {
                const absoluteTime = parseFloat(value["timemark"].split(":")[2]);
                const relativeTime = mediaEditOptions.start + absoluteTime;
                const progress = relativeTime / progressEnd;

                if (progress > lastProgress) {
                    logger.info("Video process progress:", Math.round(progress * 100), "%");
                }
            })
            .saveToFile(filepath);
    });

    // create thumbnail-generating promise
    const processThumbnailPromise = (new Promise<string>(resolve => {
        const filepath = path.join(workingDir, MEDIA_EXPORT_CONFIG.THUMBNAIL_FILENAME);
        baseCommand.on("error", err => {
            logger.error(err);
            cleanup();
            throw new HttpsError("internal", "Failed to generate thumbnail.");
        }).on("end", () => {
            logger.info("Thumbnail generated");
            resolve(filepath);
        }).thumbnail({
            filename: MEDIA_EXPORT_CONFIG.THUMBNAIL_FILENAME,
            folder: workingDir,
            timestamps: [ 0 ],
            size: MEDIA_EXPORT_CONFIG.THUMBNAIL_SIZE
        });
    }).then(async (filepath): Promise<[ string, boolean ]> => {
        const image = sharp(filepath);
        const metadata = await image.metadata();

        if (!metadata.width || !metadata.height) {
            logger.warn("Couldn't get thumbnail metadata, falling back to dark. ");
            return [ filepath, true ];
        }
        const sampleSize = Math.min(metadata.width, metadata.height, 100);

        const { data } = await image.resize(sampleSize, sampleSize).raw().toBuffer({
            resolveWithObject: true
        });

        let totalBrightness = 0;
        for (let i = 0 ; i < data.length ; i += 4) {
            const brightness = (data[i] + data[i + 1] + data[i + 2]) / 3;
            totalBrightness += brightness;
        }
        const averageBrightness = totalBrightness / (sampleSize * sampleSize);

        const threshold = 80;
        const isDark = averageBrightness < threshold;
        logger.info("Thumbnail brightness: ", averageBrightness, "is dark?", isDark);
        return [ filepath, isDark ];
    }).catch(reason => {
        logger.error("Thumbnail processing failed", reason);
        cleanup();
        throw new HttpsError("internal", "Thumbnail processing failed");
    }));

    // processing data
    const [
        exportedVideoFilepath, [ exportedThumbnailFilepath, isThumbnailDark ]
    ] = await Promise.all([ processVideoPromise, processThumbnailPromise ]);

    // getting database document reference to snap
    const docRef = getFirestore()
        .collection(`users/${ request.auth.uid }/diaries/${ diaryId }/snaps`)
        .doc();

    // uploading media to cloud storage
    const mediaStoragePath = {
        video: `diary-media/${ diaryId }/${ docRef.id }/${ MEDIA_EXPORT_CONFIG.VIDEO_FILENAME }`,
        thumbnail: `diary-media/${ diaryId }/${ docRef.id }/thumbnail.png`
    };
    await storageBucket
        .upload(exportedVideoFilepath, {
            preconditionOpts: { ifGenerationMatch: 0 },
            destination: mediaStoragePath.video
        });
    await storageBucket
        .upload(exportedThumbnailFilepath, {
            preconditionOpts: { ifGenerationMatch: 0 },
            destination: mediaStoragePath.thumbnail
        });

    // generating download URLs for media
    const videoDlUrl = await getDownloadURL(storageBucket.file(mediaStoragePath.video));
    const thumbnailDlUrl = await getDownloadURL(storageBucket.file(mediaStoragePath.thumbnail));
    await docRef.set({
        videoUrl: videoDlUrl,
        thumbnailUrl: thumbnailDlUrl,
        mediaLength: mediaDuration,
        isThumbnailDark: isThumbnailDark,
        date: date
    } as SnapType, { merge: false });

    // setting last snap length for user
    await getFirestore().doc(`/users/${ request.auth.uid }`).set({
        lastSnapLength: mediaEditOptions.length
    }, { merge: true });

    // cleaning temp folder
    await cleanup().catch(reason => {
        logger.error(reason);
        throw new HttpsError("internal", `Cleanup failed: ${ reason }`);
    });
});

export default createSnap;
