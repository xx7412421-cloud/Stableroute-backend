import app from "./index";

const PORT = process.env.PORT ?? 3001;

app.listen(PORT, () => {
  console.log(`StableRoute backend listening on http://localhost:${PORT}`);
});
