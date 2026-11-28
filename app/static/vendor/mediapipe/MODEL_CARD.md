# Model card note

`selfie_multiclass_256x256.tflite` is Google's MediaPipe multi-class selfie segmentation model
(float32, version 1), used for cutting people out of uploaded photos. Classes: 0 background,
1 hair, 2 body-skin, 3 face-skin, 4 clothes, 5 others (accessories).

Model card (MediaPipe Selfie Segmentation, the model family this one belongs to):
https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Selfie%20Segmentation.pdf
This PDF is the general selfie-segmentation card; a card specific to the multi-class variant was not
verified. Documentation: https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter

Source: https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite
sha256: c6748b1253a99067ef71f7e26ca71096cd449baefa8f101900ea23016507e0e0

The model is run in the browser only (never on the server). The runtime in this directory is
@mediapipe/tasks-vision 1.2.3, Apache-2.0 (see LICENSE). Re-create with scripts/vendor-mediapipe.sh.
