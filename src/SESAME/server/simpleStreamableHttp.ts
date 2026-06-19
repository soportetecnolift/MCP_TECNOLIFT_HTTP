import { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { McpServer } from '../../server/mcp.js';
import { StreamableHTTPServerTransport } from '../../server/streamableHttp.js';
import { getOAuthProtectedResourceMetadataUrl, mcpAuthMetadataRouter } from '../../server/auth/router.js';
import { requireBearerAuth } from '../../server/auth/middleware/bearerAuth.js';
import { createMcpExpressApp } from '../../server/express.js';
import axios from 'axios';

import {
    CallToolResult,
    ElicitResult,
    ElicitResultSchema,
    GetPromptResult,
    isInitializeRequest,
    PrimitiveSchemaDefinition,
    ReadResourceResult,
    ResourceLink
} from '../../types.js';
import { InMemoryEventStore } from '../shared/inMemoryEventStore.js';
import { InMemoryTaskStore, InMemoryTaskMessageQueue } from '../../experimental/tasks/stores/in-memory.js';
import { setupAuthServer } from './demoInMemoryOAuthProvider.js';
import { OAuthMetadata } from '../../shared/auth.js';
import { checkResourceAllowed } from '../../shared/auth-utils.js';
import dotenv from 'dotenv';
dotenv.config();

const SESAME_API_URL = process.env.SESAME_API_URL || 'https://api-eu4.sesametime.com';
const SESAME_API_TOKEN = process.env.SESAME_API_TOKEN;
// Check for OAuth flag
const useOAuth = process.argv.includes('--oauth');
const strictOAuth = process.argv.includes('--oauth-strict');

// Create shared task store for demonstration
const taskStore = new InMemoryTaskStore();

// Create an MCP server with implementation details
const getServer = () => {
    const server = new McpServer(
        {
            name: 'Sesame_Tecnolift',
            version: '1.0.0',
            icons: [{ src: './mcp.svg', sizes: ['512x512'], mimeType: 'image/svg+xml' }],
            websiteUrl: 'https://github.com/modelcontextprotocol/typescript-sdk'
        },
        {
            capabilities: { logging: {}, tasks: { requests: { tools: { call: {} } } } },
            taskStore, // Enable task support
            taskMessageQueue: new InMemoryTaskMessageQueue()
        }
    );

    // Tareas y entradas de tiempo en Sesame HR
    server.registerTool(
        'sesame_get_times_entries_task',
        {
            title: 'Obtener Entradas de Tiempo o Tareas Sesame HR', // Display name for UI
            description: 'Obtener Entradas de Tiempo o Tareas en Sesame HR',
            inputSchema: {
                from: z.string().describe("Fecha Inicial de la busqueda ejemplo 2026-01-01 (Opcional)").optional(),
                to: z.string().describe("Fecha Final de la busqueda ejemplo 2026-12-31 (Opcional)").optional(),
                employeeId: z.string().describe("Id de Empleado ejemplo e6d43c81-75d3-4e81-8888-3a239d7e4d95 (Opcional)(si no se tiene se optiene en la tool sesame_search_employees)").optional(),
                projectId: z.string().describe("Id del Proyecto ejemplo 3ba6e4a9-6920-45f9-9cbd-7811a1caf8eb (Opcional)(si no se tiene se optiene en la tool sesame_search_projects)").optional(),
                search: z.string().describe("Nombre o coincidencia de la tarea o entrada de tiempo pasar  parametro vacio si se desea listar todas las tareas (Opcional)"),
                limit: z.number().describe("Número máximo de resultados si en la primera consulta hay mas de 1 pagina consultar las restantes (default: 200)").default(200),
                page: z.number().describe("Número de pagina para consultar")
            },
            annotations: {
                title: 'Buscar Tareas o Entradas de Tiempo en Sesame HR',
                readOnlyHint: true,
                openWorldHint: false
            }
        },
        async ({ from, to, employeeId, projectId, search, limit, page }): Promise<CallToolResult> => {
            try {


                const url = `${SESAME_API_URL}/project/v1/time-entries`;

                const config = {
                    headers: {
                        Authorization: `Bearer ${SESAME_API_TOKEN}`,
                        "Content-Type": "application/json",
                    },
                    params: {
                        employeeId: employeeId || "",
                        projectId: projectId || "",
                        from: from || "",
                        to: to || "",
                        search: search || "",
                        limit: limit || 200,
                        page: page || 1
                    },
                    timeout: 10000,
                };

                const response = await axios.get(url, config);
                const tasks = response.data.data || [];

                interface TimeEntry {
                    id: string;
                    comment: string;
                    createdAt: string;
                    updatedAt: string;
                    employee?: {
                        id: string;
                        firstName: string;
                        lastName: string;
                        email: string;
                    };
                    project?: {
                        id: string;
                        name: string;
                        description: string;
                        customer?: {
                            customerName: string;
                        };
                        projectStatus?: {
                            value: string;
                        };
                    };
                    timeEntryIn?: {
                        date: string;
                    };
                    timeEntryOut?: {
                        date: string;
                    };
                }

                interface TareaFormateada {
                    id: string;
                    tarea: string;
                    fechaCreacion: string;
                    ultimaActualizacion: string;
                    empleadoId?: string;
                    empleado: string;
                    emailEmpleado?: string;
                    proyectoId?: string;
                    proyecto?: string;
                    projectIdZoho?: string;
                    cliente?: string;
                    horaEntrada?: string;
                    horaSalida?: string;
                    estadoProyecto?: string;
                }

                const tareas: TareaFormateada[] = tasks.map((x: TimeEntry): TareaFormateada => ({
                    id: x.id,
                    tarea: x.comment,
                    fechaCreacion: x.createdAt,
                    ultimaActualizacion: x.updatedAt,
                    empleadoId: x.employee?.id,
                    empleado: `${x.employee?.firstName || ""} ${x.employee?.lastName || ""}`.trim(),
                    emailEmpleado: x.employee?.email,
                    proyectoId: x.project?.id,
                    proyecto: x.project?.name,
                    projectIdZoho: x.project?.description?.replace("project_id=", ""),
                    cliente: x.project?.customer?.customerName,
                    horaEntrada: x.timeEntryIn?.date,
                    horaSalida: x.timeEntryOut?.date,
                    estadoProyecto: x.project?.projectStatus?.value
                }));

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                success: true,
                                count: tareas.length,
                                total: response.data.meta?.total || tareas.length,
                                tasks: tareas,
                            })
                        }
                    ]
                };
            } catch (error) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                error: error,
                            })
                        }
                    ]
                };
            }
        }
    );

    // Listar empleados en Sesame HR    
    server.registerTool(
        'sesame_search_employees',
        {
            description: 'Buscar empleados en Sesame HR',
            inputSchema: {
                status: z.string().describe("Filtrar por estado (active, inactive) (opcional)"),
                limit: z.number().describe("Número máximo de resultados (default: 200)").default(200),
                page: z.number().describe("Número de página para consultar (opcional)"),
                search: z.string().describe("Buscar por nombre o coincidencia (opcional)")
            },
            annotations: {
                title: 'Buscar Empleados en Sesame HR',
                readOnlyHint: true,
                openWorldHint: false
            }
        },
        async ({ status, limit, page, search }): Promise<CallToolResult> => {
            try {
                const url = `${SESAME_API_URL}/core/v3/employees`;

                const config = {
                    headers: {
                        Authorization: `Bearer ${SESAME_API_TOKEN}`,
                        "Content-Type": "application/json",
                    },
                    params: {
                        search: search || "",
                        status: status || "",
                        limit: limit || 200,
                        page: page || 1,
                    },
                    timeout: 10000,
                };

                const response = await axios.get(url, config);

                let employees = response.data.data || [];
                interface Employee {
                    id: string;
                    code: string;
                    firstName: string;
                    lastName: string;
                    email: string;
                    status: string;
                    workStatus?: string;
                    jobChargeName?: string;
                }

                // Luego úsalo así:
                employees = employees.filter((e: Employee) => e.status === status);
                // Filtrar por status si se proporciona
                if (status) {
                    employees = employees.filter((e: Employee) => e.status === status);
                }

                // Filtrar por search si se proporciona
                if (search) {
                    employees = employees.filter((e: Employee) =>
                        `${e.firstName} ${e.lastName}`.toLowerCase().includes(search.toLowerCase()) ||
                        e.email.toLowerCase().includes(search.toLowerCase()) ||
                        e.code.toLowerCase().includes(search.toLowerCase())
                    );
                }


                const formattedEmployees = employees.slice(0, limit || 50).map((e: Employee) => ({
                    id: e.id,
                    code: e.code,
                    firstName: e.firstName,
                    lastName: e.lastName,
                    email: e.email,
                    status: e.status,
                    workStatus: e.workStatus,
                    jobChargeName: e.jobChargeName,
                }));

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                success: true,
                                count: formattedEmployees.length,
                                total: response.data.meta?.total || formattedEmployees.length,
                                employees: formattedEmployees,
                            })
                        }
                    ]
                };
            } catch (error) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                error: error,
                            })
                        }
                    ]
                };
            }
        }
    );
    // listar proyectos en Sesame HR
    server.registerTool(
        'sesame_search_projects',
        {
            description: 'Buscar proyectos en Sesame HR',
            inputSchema: {
                limit: z.number().describe("Número máximo de resultados (default: 200)").default(200),
                page: z.number().describe("Número de página para consultar si en la primera consulta hay mas de 1 pagina consultar las restantes (opcional)"),
                search: z.string().describe("Nombre del proyecto a buscar (opcional)")
            },
            annotations: {
                title: 'Buscar Proyectos en Sesame HR',
                readOnlyHint: true,
                openWorldHint: false
            }
        },
        async ({ limit, page, search }): Promise<CallToolResult> => {
            try {

                const url = `${SESAME_API_URL}/project/v1/projects`;

                const config = {
                    headers: {
                        Authorization: `Bearer ${SESAME_API_TOKEN}`,
                        "Content-Type": "application/json",
                    },
                    params: {
                        id: "f0503630-4fd8-4eee-8ed9-d50250ff1601",
                        orderKey: "name",
                        search: search || "",
                        limit: limit || 200,
                        page: page || 1,
                    },
                    timeout: 10000,
                };

                const response = await axios.get(url, config);
                const projects = response.data.data || [];
                interface Project {
                    id: string;
                    name: string;
                    description: string;
                    projectStatus?: {
                        value: string;
                    };
                    startDate?: {
                        value: string;
                    };
                    endDate?: {
                        value: string;
                    };
                    updatedAt: string;
                    createdAt: string;
                    progress?: number;
                    price?: number;
                    customer?: {
                        id: string;
                        customerName: string;
                    };
                    manager?: {
                        id: string;
                        firstName: string;
                        lastName: string;
                    };
                }

                interface ProjectFormateado {
                    id: string;
                    nombre: string;
                    descripcion: string;
                    estado?: string;
                    fechaInicio?: string;
                    fechaFin?: string;
                    ultimaActualizacion: string;
                    fechaCreacion: string;
                    progreso?: number;
                    precio?: number;
                    clienteId?: string;
                    clienteNombre?: string;
                    gerenteId?: string;
                    gerenteNombre: string;
                }



                const proyectos: ProjectFormateado[] = projects.map((project: Project) => ({
                    id: project.id,
                    nombre: project.name,
                    descripcion: project.description,
                    estado: project.projectStatus?.value,
                    fechaInicio: project.startDate?.value,
                    fechaFin: project.endDate?.value,
                    ultimaActualizacion: project.updatedAt,
                    fechaCreacion: project.createdAt,
                    progreso: project.progress,
                    precio: project.price,
                    clienteId: project.customer?.id,
                    clienteNombre: project.customer?.customerName,
                    gerenteId: project.manager?.id,
                    gerenteNombre: `${project.manager?.firstName || ""} ${project.manager?.lastName || ""}`.trim()
                }));

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                success: true,
                                count: proyectos.length,
                                total: response.data.meta?.total || proyectos.length,
                                projects: proyectos,
                            })
                        }
                    ]
                };
            } catch (error) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                error: error
                            })
                        }
                    ]
                };
            }
        }
    );
    /*
    // Register a tool that demonstrates bidirectional task support:
    // Server creates a task, then elicits input from client using elicitInputStream
    // Using the experimental tasks API - WARNING: may change without notice
    server.experimental.tasks.registerToolTask(
        'collect-user-info-task',
        {
            title: 'Collect Info with Task',
            description: 'Collects user info via elicitation with task support using elicitInputStream',
            inputSchema: {
                infoType: z.enum(['contact', 'preferences']).describe('Type of information to collect').default('contact')
            }
        },
        {
            async createTask({ infoType }, { taskStore: createTaskStore, taskRequestedTtl }) {
                // Create the server-side task
                const task = await createTaskStore.createTask({
                    ttl: taskRequestedTtl
                });

                // Perform async work that makes a nested elicitation request using elicitInputStream
                (async () => {
                    try {
                        const message = infoType === 'contact' ? 'Please provide your contact information' : 'Please set your preferences';

                        // Define schemas with proper typing for PrimitiveSchemaDefinition
                        const contactSchema: {
                            type: 'object';
                            properties: Record<string, PrimitiveSchemaDefinition>;
                            required: string[];
                        } = {
                            type: 'object',
                            properties: {
                                name: { type: 'string', title: 'Full Name', description: 'Your full name' },
                                email: { type: 'string', title: 'Email', description: 'Your email address' }
                            },
                            required: ['name', 'email']
                        };

                        const preferencesSchema: {
                            type: 'object';
                            properties: Record<string, PrimitiveSchemaDefinition>;
                            required: string[];
                        } = {
                            type: 'object',
                            properties: {
                                theme: { type: 'string', title: 'Theme', enum: ['light', 'dark', 'auto'] },
                                notifications: { type: 'boolean', title: 'Enable Notifications', default: true }
                            },
                            required: ['theme']
                        };

                        const requestedSchema = infoType === 'contact' ? contactSchema : preferencesSchema;

                        // Use elicitInputStream to elicit input from client
                        // This demonstrates the streaming elicitation API
                        // Access via server.server to get the underlying Server instance
                        const stream = server.server.experimental.tasks.elicitInputStream({
                            mode: 'form',
                            message,
                            requestedSchema
                        });

                        let elicitResult: ElicitResult | undefined;
                        for await (const msg of stream) {
                            if (msg.type === 'result') {
                                elicitResult = msg.result as ElicitResult;
                            } else if (msg.type === 'error') {
                                throw msg.error;
                            }
                        }

                        if (!elicitResult) {
                            throw new Error('No result received from elicitation');
                        }

                        let resultText: string;
                        if (elicitResult.action === 'accept') {
                            resultText = `Collected ${infoType} info: ${JSON.stringify(elicitResult.content, null, 2)}`;
                        } else if (elicitResult.action === 'decline') {
                            resultText = `User declined to provide ${infoType} information`;
                        } else {
                            resultText = 'User cancelled the request';
                        }

                        await taskStore.storeTaskResult(task.taskId, 'completed', {
                            content: [{ type: 'text', text: resultText }]
                        });
                    } catch (error) {
                        console.error('Error in collect-user-info-task:', error);
                        await taskStore.storeTaskResult(task.taskId, 'failed', {
                            content: [{ type: 'text', text: `Error: ${error}` }],
                            isError: true
                        });
                    }
                })();

                return { task };
            },
            async getTask(_args, { taskId, taskStore: getTaskStore }) {
                return await getTaskStore.getTask(taskId);
            },
            async getTaskResult(_args, { taskId, taskStore: getResultTaskStore }) {
                const result = await getResultTaskStore.getTaskResult(taskId);
                return result as CallToolResult;
            }
        }
    );

    // Register a simple prompt with title
    server.registerPrompt(
        'greeting-template',
        {
            title: 'Greeting Template', // Display name for UI
            description: 'A simple greeting prompt template',
            argsSchema: {
                name: z.string().describe('Name to include in greeting')
            }
        },
        async ({ name }): Promise<GetPromptResult> => {
            return {
                messages: [
                    {
                        role: 'user',
                        content: {
                            type: 'text',
                            text: `Please greet ${name} in a friendly manner.`
                        }
                    }
                ]
            };
        }
    );

    // Register a tool specifically for testing resumability
    server.registerTool(
        'start-notification-stream',
        {
            description: 'Starts sending periodic notifications for testing resumability',
            inputSchema: {
                interval: z.number().describe('Interval in milliseconds between notifications').default(100),
                count: z.number().describe('Number of notifications to send (0 for 100)').default(50)
            }
        },
        async ({ interval, count }, extra): Promise<CallToolResult> => {
            const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
            let counter = 0;

            while (count === 0 || counter < count) {
                counter++;
                try {
                    await server.sendLoggingMessage(
                        {
                            level: 'info',
                            data: `Periodic notification #${counter} at ${new Date().toISOString()}`
                        },
                        extra.sessionId
                    );
                } catch (error) {
                    console.error('Error sending notification:', error);
                }
                // Wait for the specified interval
                await sleep(interval);
            }

            return {
                content: [
                    {
                        type: 'text',
                        text: `Started sending periodic notifications every ${interval}ms`
                    }
                ]
            };
        }
    );

    // Create a simple resource at a fixed URI
    server.registerResource(
        'greeting-resource',
        'https://example.com/greetings/default',
        {
            title: 'Default Greeting', // Display name for UI
            description: 'A simple greeting resource',
            mimeType: 'text/plain'
        },
        async (): Promise<ReadResourceResult> => {
            return {
                contents: [
                    {
                        uri: 'https://example.com/greetings/default',
                        text: 'Hello, world!'
                    }
                ]
            };
        }
    );

    // Create additional resources for ResourceLink demonstration
    server.registerResource(
        'example-file-1',
        'file:///example/file1.txt',
        {
            title: 'Example File 1',
            description: 'First example file for ResourceLink demonstration',
            mimeType: 'text/plain'
        },
        async (): Promise<ReadResourceResult> => {
            return {
                contents: [
                    {
                        uri: 'file:///example/file1.txt',
                        text: 'This is the content of file 1'
                    }
                ]
            };
        }
    );

    server.registerResource(
        'example-file-2',
        'file:///example/file2.txt',
        {
            title: 'Example File 2',
            description: 'Second example file for ResourceLink demonstration',
            mimeType: 'text/plain'
        },
        async (): Promise<ReadResourceResult> => {
            return {
                contents: [
                    {
                        uri: 'file:///example/file2.txt',
                        text: 'This is the content of file 2'
                    }
                ]
            };
        }
    );

    // Register a tool that returns ResourceLinks
    server.registerTool(
        'list-files',
        {
            title: 'List Files with ResourceLinks',
            description: 'Returns a list of files as ResourceLinks without embedding their content',
            inputSchema: {
                includeDescriptions: z.boolean().optional().describe('Whether to include descriptions in the resource links')
            }
        },
        async ({ includeDescriptions = true }): Promise<CallToolResult> => {
            const resourceLinks: ResourceLink[] = [
                {
                    type: 'resource_link',
                    uri: 'https://example.com/greetings/default',
                    name: 'Default Greeting',
                    mimeType: 'text/plain',
                    ...(includeDescriptions && { description: 'A simple greeting resource' })
                },
                {
                    type: 'resource_link',
                    uri: 'file:///example/file1.txt',
                    name: 'Example File 1',
                    mimeType: 'text/plain',
                    ...(includeDescriptions && { description: 'First example file for ResourceLink demonstration' })
                },
                {
                    type: 'resource_link',
                    uri: 'file:///example/file2.txt',
                    name: 'Example File 2',
                    mimeType: 'text/plain',
                    ...(includeDescriptions && { description: 'Second example file for ResourceLink demonstration' })
                }
            ];

            return {
                content: [
                    {
                        type: 'text',
                        text: 'Here are the available files as resource links:'
                    },
                    ...resourceLinks,
                    {
                        type: 'text',
                        text: '\nYou can read any of these resources using their URI.'
                    }
                ]
            };
        }
    );

    // Register a long-running tool that demonstrates task execution
    // Using the experimental tasks API - WARNING: may change without notice
    server.experimental.tasks.registerToolTask(
        'delay',
        {
            title: 'Delay',
            description: 'A simple tool that delays for a specified duration, useful for testing task execution',
            inputSchema: {
                duration: z.number().describe('Duration in milliseconds').default(5000)
            }
        },
        {
            async createTask({ duration }, { taskStore, taskRequestedTtl }) {
                // Create the task
                const task = await taskStore.createTask({
                    ttl: taskRequestedTtl
                });

                // Simulate out-of-band work
                (async () => {
                    await new Promise(resolve => setTimeout(resolve, duration));
                    await taskStore.storeTaskResult(task.taskId, 'completed', {
                        content: [
                            {
                                type: 'text',
                                text: `Completed ${duration}ms delay`
                            }
                        ]
                    });
                })();

                // Return CreateTaskResult with the created task
                return {
                    task
                };
            },
            async getTask(_args, { taskId, taskStore }) {
                return await taskStore.getTask(taskId);
            },
            async getTaskResult(_args, { taskId, taskStore }) {
                const result = await taskStore.getTaskResult(taskId);
                return result as CallToolResult;
            }
        }
    );
*/
    return server;
};

const MCP_PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT, 10) : 3000;
const AUTH_PORT = process.env.MCP_AUTH_PORT ? parseInt(process.env.MCP_AUTH_PORT, 10) : 3001;

const app = createMcpExpressApp({
    host: '0.0.0.0'
});

// Set up OAuth if enabled
let authMiddleware = null;
if (useOAuth) {
    // Create auth middleware for MCP endpoints
    const mcpServerUrl = new URL(`http://localhost:${MCP_PORT}/mcp`);
    const authServerUrl = new URL(`http://localhost:${AUTH_PORT}`);

    const oauthMetadata: OAuthMetadata = setupAuthServer({ authServerUrl, mcpServerUrl, strictResource: strictOAuth });

    const tokenVerifier = {
        verifyAccessToken: async (token: string) => {
            const endpoint = oauthMetadata.introspection_endpoint;

            if (!endpoint) {
                throw new Error('No token verification endpoint available in metadata');
            }

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({
                    token: token
                }).toString()
            });

            if (!response.ok) {
                const text = await response.text().catch(() => null);
                throw new Error(`Invalid or expired token: ${text}`);
            }

            const data = await response.json();

            if (strictOAuth) {
                if (!data.aud) {
                    throw new Error(`Resource Indicator (RFC8707) missing`);
                }
                if (!checkResourceAllowed({ requestedResource: data.aud, configuredResource: mcpServerUrl })) {
                    throw new Error(`Expected resource indicator ${mcpServerUrl}, got: ${data.aud}`);
                }
            }

            // Convert the response to AuthInfo format
            return {
                token,
                clientId: data.client_id,
                scopes: data.scope ? data.scope.split(' ') : [],
                expiresAt: data.exp
            };
        }
    };
    // Add metadata routes to the main MCP server
    app.use(
        mcpAuthMetadataRouter({
            oauthMetadata,
            resourceServerUrl: mcpServerUrl,
            scopesSupported: ['mcp:tools'],
            resourceName: 'MCP Demo Server'
        })
    );

    authMiddleware = requireBearerAuth({
        verifier: tokenVerifier,
        requiredScopes: [],
        resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpServerUrl)
    });
}

// Map to store transports by session ID
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

// MCP POST endpoint with optional auth
const mcpPostHandler = async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId) {
        console.log(`Received MCP request for session: ${sessionId}`);
    } else {
        console.log('Request body:', req.body);
    }

    if (useOAuth && req.auth) {
        console.log('Authenticated user:', req.auth);
    }
    try {
        let transport: StreamableHTTPServerTransport;
        if (sessionId && transports[sessionId]) {
            // Reuse existing transport
            transport = transports[sessionId];
        } else if (!sessionId && isInitializeRequest(req.body)) {
            // New initialization request
            const eventStore = new InMemoryEventStore();
            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                eventStore, // Enable resumability
                onsessioninitialized: sessionId => {
                    // Store the transport by session ID when session is initialized
                    // This avoids race conditions where requests might come in before the session is stored
                    console.log(`Session initialized with ID: ${sessionId}`);
                    transports[sessionId] = transport;
                }
            });

            // Set up onclose handler to clean up transport when closed
            transport.onclose = () => {
                const sid = transport.sessionId;
                if (sid && transports[sid]) {
                    console.log(`Transport closed for session ${sid}, removing from transports map`);
                    delete transports[sid];
                }
            };

            // Connect the transport to the MCP server BEFORE handling the request
            // so responses can flow back through the same transport
            const server = getServer();
            await server.connect(transport);

            await transport.handleRequest(req, res, req.body);
            return; // Already handled
        } else {
            // Invalid request - no session ID or not initialization request
            res.status(400).json({
                jsonrpc: '2.0',
                error: {
                    code: -32000,
                    message: 'Bad Request: No valid session ID provided'
                },
                id: null
            });
            return;
        }

        // Handle the request with existing transport - no need to reconnect
        // The existing transport is already connected to the server
        await transport.handleRequest(req, res, req.body);
    } catch (error) {
        console.error('Error handling MCP request:', error);
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: '2.0',
                error: {
                    code: -32603,
                    message: 'Internal server error'
                },
                id: null
            });
        }
    }
};

// Set up routes with conditional auth middleware
if (useOAuth && authMiddleware) {
    app.post('/mcp', authMiddleware, mcpPostHandler);
} else {
    app.post('/mcp', mcpPostHandler);
}

// Handle GET requests for SSE streams (using built-in support from StreamableHTTP)
const mcpGetHandler = async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
    }

    if (useOAuth && req.auth) {
        console.log('Authenticated SSE connection from user:', req.auth);
    }

    // Check for Last-Event-ID header for resumability
    const lastEventId = req.headers['last-event-id'] as string | undefined;
    if (lastEventId) {
        console.log(`Client reconnecting with Last-Event-ID: ${lastEventId}`);
    } else {
        console.log(`Establishing new SSE stream for session ${sessionId}`);
    }

    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
};

// Set up GET route with conditional auth middleware
if (useOAuth && authMiddleware) {
    app.get('/mcp', authMiddleware, mcpGetHandler);
} else {
    app.get('/mcp', mcpGetHandler);
}
app.get("/", (_req, res) => {
    res.send("MCP Streamable HTTP Server is running");
});
// Handle DELETE requests for session termination (according to MCP spec)
const mcpDeleteHandler = async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
    }

    console.log(`Received session termination request for session ${sessionId}`);

    try {
        const transport = transports[sessionId];
        await transport.handleRequest(req, res);
    } catch (error) {
        console.error('Error handling session termination:', error);
        if (!res.headersSent) {
            res.status(500).send('Error processing session termination');
        }
    }
};

// Set up DELETE route with conditional auth middleware
if (useOAuth && authMiddleware) {
    app.delete('/mcp', authMiddleware, mcpDeleteHandler);
} else {
    app.delete('/mcp', mcpDeleteHandler);
}

app.listen(MCP_PORT, error => {
    if (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
    console.log(`MCP Streamable HTTP Server listening on port ${MCP_PORT}`);
});

// Handle server shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down server...');

    // Close all active transports to properly clean up resources
    for (const sessionId in transports) {
        try {
            console.log(`Closing transport for session ${sessionId}`);
            await transports[sessionId].close();
            delete transports[sessionId];
        } catch (error) {
            console.error(`Error closing transport for session ${sessionId}:`, error);
        }
    }
    console.log('Server shutdown complete');
    process.exit(0);
});
