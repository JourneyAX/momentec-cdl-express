# Upload AI design

- Open `/upload-ai-design`.
- The customer drops their photos. Those files are saved in `assets/user-uploaded/<id>` when they submit.

## APIs

- `POST /api/upload-ai-design/generate` turns the dropped photos into front, back, left, and right.
- `POST /api/upload-ai-design/model` takes those four views and returns a 3D model. Optional. Marked beta.
- `POST /api/upload-ai-design/submit` accepts the form right away. The page does not wait.
- When the art files are ready, the server calls `POST /api/upload-ai-design/intake` with the customer's name, email, category, message, and one zip. (this is going to be the augusta endpoint)
- The zip holds the four views, the SVG files, the original photos, and `model.glb` if a 3D model was made.
- Open `/upload-ai-design/orders` and refresh it. (this is implemented just for our local development reference)
- Status is **Design received** and **Assets creation in progress**, then **Assets ready**.
- `GET /api/upload-ai-design/orders/<id>` downloads that zip.(this is only implemented just for our local development reference)
