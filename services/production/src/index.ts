import { app } from "./app.js";
import { migrate } from "./db.js";

const port = Number(process.env.PORT ?? 3002);

await migrate();
app.listen(port, () => console.log(`production listening on ${port}`));
