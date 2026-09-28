import { createServerFn } from "@tanstack/react-start"
import { currentUser } from "./auth.server"

export const getSessionFn = createServerFn({ method: "GET" }).handler(() => currentUser())
