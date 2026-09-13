#!/usr/bin/env node

import 'dotenv/config';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";
import * as fs from "fs";
import * as path from "path";

// Configuration
const N8N_HOST = process.env.N8N_HOST || 'http://localhost:5678';
const N8N_API_KEY = process.env.N8N_API_KEY || '';

console.error("N8N API Configuration:");
console.error("Host:", N8N_HOST);
console.error("API Key:", N8N_API_KEY ? `${N8N_API_KEY.substring(0, 4)}****` : 'Not set');

// Create axios instance for n8n API
const n8nApi = axios.create({
  baseURL: N8N_HOST,
  headers: {
    'X-N8N-API-KEY': N8N_API_KEY,
    'Content-Type': 'application/json'
  }
});

// Create MCP server with modern SDK 1.17.0 API
const server = new McpServer({
  name: "n8n-workflow-builder",
  version: "0.11.0"
});

// Register workflow management tools using modern MCP SDK 1.17.0 API
server.tool(
  "list_workflows",
  "List all workflows with summary info only (id, name, active, tags, node count). Use get_workflow for full details.",
  {},
  async () => {
    try {
      const response = await n8nApi.get('/workflows');
      const workflows = response.data.data || response.data;

      // Return summary only - much more token efficient
      const summary = workflows.map((w: any) => ({
        id: w.id,
        name: w.name,
        active: w.active,
        tags: w.tags?.map((t: any) => t.name || t) || [],
        nodeCount: w.nodes?.length || 0,
        createdAt: w.createdAt,
        updatedAt: w.updatedAt
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ count: summary.length, workflows: summary }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "list_workflows_full",
  "List all workflows with complete data including nodes and connections. Warning: high token usage.",
  {},
  async () => {
    try {
      const response = await n8nApi.get('/workflows');
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "create_workflow",
  "Create a new workflow in n8n",
  {
    workflow: z.object({
      name: z.string().describe("Name of the workflow"),
      nodes: z.array(z.unknown()).describe("Array of workflow nodes"),
      connections: z.record(z.string(), z.any()).optional().describe("Node connections"),
      settings: z.record(z.string(), z.any()).optional().describe("Workflow settings"),
      tags: z.array(z.unknown()).optional().describe("Workflow tags")
    }).describe("Workflow configuration")
  },
  async ({ workflow }) => {
    try {
      const response = await n8nApi.post('/workflows', workflow);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "get_workflow",
  "Get a workflow by ID. Returns summary by default, pass full=true for complete data (or use download_workflow to save to file)",
  {
    id: z.string().describe("Workflow ID"),
    full: z.boolean().optional().default(false).describe("Return full workflow data including nodes/connections (default: false)")
  },
  async ({ id, full }) => {
    try {
      const response = await n8nApi.get(`/workflows/${id}`);
      const workflow = response.data;

      if (full) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify(workflow, null, 2)
          }]
        };
      }

      // Return summary with node names only
      const summary = {
        id: workflow.id,
        name: workflow.name,
        active: workflow.active,
        tags: workflow.tags?.map((t: any) => t.name || t) || [],
        nodeCount: workflow.nodes?.length || 0,
        nodes: workflow.nodes?.map((n: any) => ({ name: n.name, type: n.type })) || [],
        createdAt: workflow.createdAt,
        updatedAt: workflow.updatedAt
      };

      return {
        content: [{
          type: "text",
          text: JSON.stringify(summary, null, 2)
        }]
      };
    } catch (error: any) {
      const details = error.response?.data || error.message || String(error);
      return {
        content: [{
          type: "text",
          text: `Error: ${JSON.stringify(details, null, 2)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "download_workflow",
  "Download a workflow and save it to a local JSON file (avoids dumping to chat)",
  {
    id: z.string().describe("Workflow ID"),
    filePath: z.string().optional().describe("File path to save (default: ./workflows/{name}.json)")
  },
  async ({ id, filePath }) => {
    try {
      const response = await n8nApi.get(`/workflows/${id}`);
      const workflow = response.data;

      // Generate filename from workflow name if not provided
      let outputPath = filePath;
      if (!outputPath) {
        const safeName = workflow.name.replace(/[^a-zA-Z0-9-_]/g, '_');
        const dir = './workflows';
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        outputPath = path.join(dir, `${safeName}.json`);
      }

      // Write workflow to file
      fs.writeFileSync(outputPath, JSON.stringify(workflow, null, 2));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Workflow saved to ${outputPath}`,
            workflowId: id,
            workflowName: workflow.name,
            filePath: outputPath,
            nodeCount: workflow.nodes?.length || 0
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "upload_workflow",
  "Upload a workflow from a local JSON file to n8n (creates new workflow)",
  {
    filePath: z.string().describe("Path to the workflow JSON file"),
    activate: z.boolean().optional().default(false).describe("Activate the workflow after upload")
  },
  async ({ filePath, activate }) => {
    try {
      // Read workflow from file
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      const workflow = JSON.parse(fileContent);

      // Remove id so n8n creates a new one
      delete workflow.id;

      // Create workflow
      const createResponse = await n8nApi.post('/workflows', workflow);
      const newWorkflow = createResponse.data;

      // Optionally activate
      if (activate) {
        await n8nApi.post(`/workflows/${newWorkflow.id}/activate`);
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Workflow uploaded${activate ? ' and activated' : ''}`,
            workflowId: newWorkflow.id,
            workflowName: newWorkflow.name,
            active: activate,
            filePath
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "update_workflow",
  "Update an existing workflow by ID",
  {
    id: z.string().describe("Workflow ID"),
    workflow: z.object({
      name: z.string().optional().describe("Name of the workflow"),
      nodes: z.array(z.unknown()).optional().describe("Array of workflow nodes"),
      connections: z.record(z.string(), z.any()).optional().describe("Node connections"),
      settings: z.record(z.string(), z.any()).optional().describe("Workflow settings"),
      tags: z.array(z.unknown()).optional().describe("Workflow tags")
    }).describe("Updated workflow configuration")
  },
  async ({ id, workflow }) => {
    try {
      const response = await n8nApi.put(`/workflows/${id}`, workflow);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error: any) {
      const details = error.response?.data || error.message || String(error);
      return {
        content: [{
          type: "text",
          text: `Error: ${JSON.stringify(details, null, 2)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "delete_workflow",
  "Delete a workflow by ID",
  {
    id: z.string().describe("Workflow ID")
  },
  async ({ id }) => {
    try {
      const response = await n8nApi.delete(`/workflows/${id}`);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Workflow ${id} deleted successfully`,
            deletedWorkflow: response.data
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "activate_workflow",
  "Activate a workflow by ID",
  {
    id: z.string().describe("Workflow ID")
  },
  async ({ id }) => {
    try {
      const response = await n8nApi.post(`/workflows/${id}/activate`);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Workflow ${id} activated`,
            workflowId: response.data.id,
            name: response.data.name,
            active: response.data.active
          }, null, 2)
        }]
      };
    } catch (error: any) {
      const details = error.response?.data || error.message || String(error);
      return {
        content: [{
          type: "text",
          text: `Error: ${JSON.stringify(details, null, 2)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "deactivate_workflow",
  "Deactivate a workflow by ID",
  {
    id: z.string().describe("Workflow ID")
  },
  async ({ id }) => {
    try {
      const response = await n8nApi.post(`/workflows/${id}/deactivate`);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Workflow ${id} deactivated`,
            workflowId: response.data.id,
            name: response.data.name,
            active: response.data.active
          }, null, 2)
        }]
      };
    } catch (error: any) {
      const details = error.response?.data || error.message || String(error);
      return {
        content: [{
          type: "text",
          text: `Error: ${JSON.stringify(details, null, 2)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "execute_workflow",
  "Execute a workflow manually",
  {
    id: z.string().describe("Workflow ID")
  },
  async ({ id }) => {
    try {
      const response = await n8nApi.post(`/workflows/${id}/execute`);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Workflow ${id} executed`,
            executionId: response.data.id || response.data.executionId,
            status: response.data.status || 'started'
          }, null, 2)
        }]
      };
    } catch (error: any) {
      const details = error.response?.data || error.message || String(error);
      return {
        content: [{
          type: "text",
          text: `Error: ${JSON.stringify(details, null, 2)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "create_workflow_and_activate",
  "Create a new workflow and immediately activate it",
  {
    workflow: z.object({
      name: z.string().describe("Name of the workflow"),
      nodes: z.array(z.unknown()).describe("Array of workflow nodes"),
      connections: z.record(z.string(), z.any()).optional().describe("Node connections"),
      settings: z.record(z.string(), z.any()).optional().describe("Workflow settings"),
      tags: z.array(z.unknown()).optional().describe("Workflow tags")
    }).describe("Workflow configuration")
  },
  async ({ workflow }) => {
    try {
      // First create the workflow
      const createResponse = await n8nApi.post('/workflows', workflow);
      const workflowId = createResponse.data.id;
      const workflowName = createResponse.data.name;

      // Then activate it
      await n8nApi.post(`/workflows/${workflowId}/activate`);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Workflow created and activated`,
            workflowId,
            name: workflowName,
            active: true
          }, null, 2)
        }]
      };
    } catch (error: any) {
      const details = error.response?.data || error.message || String(error);
      return {
        content: [{
          type: "text",
          text: `Error: ${JSON.stringify(details, null, 2)}`
        }],
        isError: true
      };
    }
  }
);

// Execution Management Tools
server.tool(
  "list_executions",
  "List workflow executions with filtering and pagination support",
  {
    includeData: z.boolean().optional().describe("Include execution's detailed data"),
    status: z.enum(["error", "success", "waiting"]).optional().describe("Filter by execution status"),
    workflowId: z.string().optional().describe("Filter by specific workflow ID"),
    projectId: z.string().optional().describe("Filter by project ID"),
    limit: z.number().min(1).max(250).optional().describe("Number of executions to return (max: 250)"),
    cursor: z.string().optional().describe("Pagination cursor for next page")
  },
  async ({ includeData, status, workflowId, projectId, limit, cursor }) => {
    try {
      const params = new URLSearchParams();

      if (includeData !== undefined) params.append('includeData', includeData.toString());
      if (status) params.append('status', status);
      if (workflowId) params.append('workflowId', workflowId);
      if (projectId) params.append('projectId', projectId);
      if (limit) params.append('limit', limit.toString());
      if (cursor) params.append('cursor', cursor);

      const response = await n8nApi.get(`/executions?${params.toString()}`);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "get_execution",
  "Get detailed information about a specific workflow execution",
  {
    id: z.string().describe("Execution ID"),
    includeData: z.boolean().optional().describe("Include detailed execution data")
  },
  async ({ id, includeData }) => {
    try {
      const params = new URLSearchParams();
      if (includeData !== undefined) params.append('includeData', includeData.toString());

      const url = `/executions/${id}${params.toString() ? `?${params.toString()}` : ''}`;
      const response = await n8nApi.get(url);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "delete_execution",
  "Delete a workflow execution record from the n8n instance",
  {
    id: z.string().describe("Execution ID to delete")
  },
  async ({ id }) => {
    try {
      const response = await n8nApi.delete(`/executions/${id}`);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Execution ${id} deleted successfully`,
            deletedExecution: response.data
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
);

// Tag Management Tools
server.tool(
  "list_tags",
  "List all workflow tags with pagination support",
  {
    limit: z.number().min(1).max(250).optional().describe("Number of tags to return (max: 250)"),
    cursor: z.string().optional().describe("Pagination cursor for next page")
  },
  async ({ limit, cursor }) => {
    try {
      const params = new URLSearchParams();

      if (limit) params.append('limit', limit.toString());
      if (cursor) params.append('cursor', cursor);

      const response = await n8nApi.get(`/tags?${params.toString()}`);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "create_tag",
  "Create a new workflow tag for organization and categorization",
  {
    name: z.string().describe("Name of the tag to create")
  },
  async ({ name }) => {
    try {
      const response = await n8nApi.post('/tags', { name });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Tag '${name}' created successfully`,
            tag: response.data
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "get_tag",
  "Retrieve individual tag details by ID",
  {
    id: z.string().describe("Tag ID")
  },
  async ({ id }) => {
    try {
      const response = await n8nApi.get(`/tags/${id}`);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            tag: response.data,
            message: `Tag ${id} retrieved successfully`
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "update_tag",
  "Modify tag names for better organization",
  {
    id: z.string().describe("Tag ID"),
    name: z.string().describe("New name for the tag")
  },
  async ({ id, name }) => {
    try {
      const response = await n8nApi.put(`/tags/${id}`, { name });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Tag ${id} updated successfully`,
            tag: response.data
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "delete_tag",
  "Remove unused tags from the system",
  {
    id: z.string().describe("Tag ID to delete")
  },
  async ({ id }) => {
    try {
      const response = await n8nApi.delete(`/tags/${id}`);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Tag ${id} deleted successfully`,
            deletedTag: response.data
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "get_workflow_tags",
  "Get all tags associated with a specific workflow",
  {
    workflowId: z.string().describe("Workflow ID")
  },
  async ({ workflowId }) => {
    try {
      const response = await n8nApi.get(`/workflows/${workflowId}/tags`);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            workflowId,
            tags: response.data,
            message: `Tags for workflow ${workflowId} retrieved successfully`
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "update_workflow_tags",
  "Assign or remove tags from workflows",
  {
    workflowId: z.string().describe("Workflow ID"),
    tagIds: z.array(z.string()).describe("Array of tag IDs to assign to the workflow")
  },
  async ({ workflowId, tagIds }) => {
    try {
      const response = await n8nApi.put(`/workflows/${workflowId}/tags`, { tagIds });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Tags for workflow ${workflowId} updated successfully`,
            workflowId,
            assignedTags: response.data
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
);

// Credential Management Tools
server.tool(
  "create_credential",
  "Create a new credential for workflow authentication. Use get_credential_schema first to understand required fields for the credential type.",
  {
    name: z.string().describe("Name for the credential"),
    type: z.string().describe("Credential type (e.g., 'httpBasicAuth', 'httpHeaderAuth', 'oAuth2Api', etc.)"),
    data: z.record(z.string(), z.any()).describe("Credential data object with required fields for the credential type")
  },
  async ({ name, type, data }) => {
    try {
      const response = await n8nApi.post('/credentials', {
        name,
        type,
        data
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Credential '${name}' created successfully`,
            credential: {
              id: response.data.id,
              name: response.data.name,
              type: response.data.type,
              createdAt: response.data.createdAt
            }
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "get_credential_schema",
  "Get the schema for a specific credential type to understand what fields are required when creating credentials.",
  {
    credentialType: z.string().describe("Credential type name (e.g., 'httpBasicAuth', 'httpHeaderAuth', 'oAuth2Api', 'githubApi', 'slackApi', etc.)")
  },
  async ({ credentialType }) => {
    try {
      const response = await n8nApi.get(`/credentials/schema/${credentialType}`);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            credentialType,
            schema: response.data,
            message: `Schema for credential type '${credentialType}' retrieved successfully`
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "delete_credential",
  "Delete a credential by ID. This will remove the credential and make it unavailable for workflows. Use with caution as this action cannot be undone.",
  {
    id: z.string().describe("Credential ID to delete")
  },
  async ({ id }) => {
    try {
      const response = await n8nApi.delete(`/credentials/${id}`);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Credential ${id} deleted successfully`,
            deletedCredential: response.data
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
);

// Granular Workflow Update Tools (token-efficient partial updates)
// These tools fetch the workflow, apply targeted changes, and PUT it back
// so users don't need to send the entire workflow object

// Helper: Strip workflow to only fields allowed by n8n PUT API
// n8n API rejects extra fields like id, createdAt, updatedAt, tags (read-only), etc.
function stripWorkflowForUpdate(workflow: any): any {
  return {
    name: workflow.name,
    nodes: workflow.nodes,
    connections: workflow.connections,
    settings: workflow.settings,
    staticData: workflow.staticData
  };
}

server.tool(
  "update_workflow_name",
  "Rename a workflow without sending the full workflow object",
  {
    id: z.string().describe("Workflow ID"),
    name: z.string().describe("New name for the workflow")
  },
  async ({ id, name }) => {
    try {
      // Fetch current workflow
      const getResponse = await n8nApi.get(`/workflows/${id}`);
      const workflow = getResponse.data;

      // Update name
      workflow.name = name;

      // Save back (strip to allowed fields only)
      const response = await n8nApi.put(`/workflows/${id}`, stripWorkflowForUpdate(workflow));
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Workflow renamed to '${name}'`,
            workflowId: id
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "add_node",
  "Add a single node to an existing workflow",
  {
    workflowId: z.string().describe("Workflow ID"),
    node: z.object({
      name: z.string().describe("Node name (must be unique in workflow)"),
      type: z.string().describe("Node type (e.g., 'n8n-nodes-base.httpRequest')"),
      typeVersion: z.number().optional().default(1).describe("Node type version"),
      position: z.tuple([z.number(), z.number()]).describe("Node position [x, y]"),
      parameters: z.record(z.string(), z.any()).optional().describe("Node parameters")
    }).describe("Node to add")
  },
  async ({ workflowId, node }) => {
    try {
      // Fetch current workflow
      const getResponse = await n8nApi.get(`/workflows/${workflowId}`);
      const workflow = getResponse.data;

      // Check for duplicate node name
      if (workflow.nodes.some((n: any) => n.name === node.name)) {
        return {
          content: [{
            type: "text",
            text: `Error: Node with name '${node.name}' already exists in workflow`
          }],
          isError: true
        };
      }

      // Add the node
      workflow.nodes.push({
        id: node.name.toLowerCase().replace(/\s+/g, '-'),
        name: node.name,
        type: node.type,
        typeVersion: node.typeVersion || 1,
        position: node.position,
        parameters: node.parameters || {}
      });

      // Save back
      const response = await n8nApi.put(`/workflows/${workflowId}`, stripWorkflowForUpdate(workflow));
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Node '${node.name}' added to workflow`,
            workflowId,
            nodeCount: workflow.nodes.length
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "update_node",
  "Update a specific node's parameters in a workflow (for small params - use update_node_from_file for large content like SQL)",
  {
    workflowId: z.string().describe("Workflow ID"),
    nodeName: z.string().describe("Name of the node to update"),
    parameters: z.record(z.string(), z.any()).describe("Parameters to update (merged with existing)")
  },
  async ({ workflowId, nodeName, parameters }) => {
    try {
      // Fetch current workflow
      const getResponse = await n8nApi.get(`/workflows/${workflowId}`);
      const workflow = getResponse.data;

      // Find the node
      const nodeIndex = workflow.nodes.findIndex((n: any) => n.name === nodeName);
      if (nodeIndex === -1) {
        return {
          content: [{
            type: "text",
            text: `Error: Node '${nodeName}' not found in workflow`
          }],
          isError: true
        };
      }

      // Merge parameters
      workflow.nodes[nodeIndex].parameters = {
        ...workflow.nodes[nodeIndex].parameters,
        ...parameters
      };

      // Save back
      const response = await n8nApi.put(`/workflows/${workflowId}`, stripWorkflowForUpdate(workflow));
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Node '${nodeName}' updated`,
            workflowId,
            updatedParameters: Object.keys(parameters)
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "update_node_from_file",
  "Update a node parameter by reading value from a file (ideal for long SQL queries, scripts, templates)",
  {
    workflowId: z.string().describe("Workflow ID"),
    nodeName: z.string().describe("Name of the node to update"),
    parameterName: z.string().describe("Name of the parameter to update (e.g., 'query', 'jsCode', 'htmlTemplate')"),
    filePath: z.string().describe("Path to file containing the parameter value")
  },
  async ({ workflowId, nodeName, parameterName, filePath }) => {
    try {
      // Read value from file
      const fileContent = fs.readFileSync(filePath, 'utf-8');

      // Fetch current workflow
      const getResponse = await n8nApi.get(`/workflows/${workflowId}`);
      const workflow = getResponse.data;

      // Find the node
      const nodeIndex = workflow.nodes.findIndex((n: any) => n.name === nodeName);
      if (nodeIndex === -1) {
        return {
          content: [{
            type: "text",
            text: `Error: Node '${nodeName}' not found in workflow. Available nodes: ${workflow.nodes.map((n: any) => n.name).join(', ')}`
          }],
          isError: true
        };
      }

      // Update the specific parameter
      if (!workflow.nodes[nodeIndex].parameters) {
        workflow.nodes[nodeIndex].parameters = {};
      }
      workflow.nodes[nodeIndex].parameters[parameterName] = fileContent;

      // Save back
      const response = await n8nApi.put(`/workflows/${workflowId}`, stripWorkflowForUpdate(workflow));
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Node '${nodeName}' parameter '${parameterName}' updated from file`,
            workflowId,
            nodeName,
            parameterName,
            filePath,
            contentLength: fileContent.length
          }, null, 2)
        }]
      };
    } catch (error: any) {
      // Extract detailed error from axios response
      const details = error.response?.data || error.message || String(error);
      return {
        content: [{
          type: "text",
          text: `Error: ${JSON.stringify(details, null, 2)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "remove_node",
  "Remove a node from a workflow (also removes its connections)",
  {
    workflowId: z.string().describe("Workflow ID"),
    nodeName: z.string().describe("Name of the node to remove")
  },
  async ({ workflowId, nodeName }) => {
    try {
      // Fetch current workflow
      const getResponse = await n8nApi.get(`/workflows/${workflowId}`);
      const workflow = getResponse.data;

      // Find and remove the node
      const nodeIndex = workflow.nodes.findIndex((n: any) => n.name === nodeName);
      if (nodeIndex === -1) {
        return {
          content: [{
            type: "text",
            text: `Error: Node '${nodeName}' not found in workflow`
          }],
          isError: true
        };
      }

      workflow.nodes.splice(nodeIndex, 1);

      // Remove connections involving this node
      if (workflow.connections) {
        // Remove outgoing connections from this node
        delete workflow.connections[nodeName];

        // Remove incoming connections to this node
        for (const sourceNode of Object.keys(workflow.connections)) {
          const sourceConnections = workflow.connections[sourceNode];
          if (sourceConnections?.main) {
            for (const outputIndex of Object.keys(sourceConnections.main)) {
              sourceConnections.main[outputIndex] = sourceConnections.main[outputIndex].filter(
                (conn: any) => conn.node !== nodeName
              );
            }
          }
        }
      }

      // Save back
      const response = await n8nApi.put(`/workflows/${workflowId}`, stripWorkflowForUpdate(workflow));
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Node '${nodeName}' removed from workflow`,
            workflowId,
            remainingNodes: workflow.nodes.length
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "connect_nodes",
  "Connect two nodes in a workflow",
  {
    workflowId: z.string().describe("Workflow ID"),
    sourceNode: z.string().describe("Name of the source node"),
    targetNode: z.string().describe("Name of the target node"),
    sourceOutput: z.number().optional().default(0).describe("Source output index (default: 0)"),
    targetInput: z.number().optional().default(0).describe("Target input index (default: 0)")
  },
  async ({ workflowId, sourceNode, targetNode, sourceOutput = 0, targetInput = 0 }) => {
    try {
      // Fetch current workflow
      const getResponse = await n8nApi.get(`/workflows/${workflowId}`);
      const workflow = getResponse.data;

      // Verify both nodes exist
      const sourceExists = workflow.nodes.some((n: any) => n.name === sourceNode);
      const targetExists = workflow.nodes.some((n: any) => n.name === targetNode);

      if (!sourceExists) {
        return {
          content: [{ type: "text", text: `Error: Source node '${sourceNode}' not found` }],
          isError: true
        };
      }
      if (!targetExists) {
        return {
          content: [{ type: "text", text: `Error: Target node '${targetNode}' not found` }],
          isError: true
        };
      }

      // Initialize connections structure if needed
      if (!workflow.connections) workflow.connections = {};
      if (!workflow.connections[sourceNode]) workflow.connections[sourceNode] = {};
      if (!workflow.connections[sourceNode].main) workflow.connections[sourceNode].main = [];

      // Ensure the output array exists
      while (workflow.connections[sourceNode].main.length <= sourceOutput) {
        workflow.connections[sourceNode].main.push([]);
      }

      // Add connection if not already present
      const existingConn = workflow.connections[sourceNode].main[sourceOutput].find(
        (c: any) => c.node === targetNode && c.index === targetInput
      );

      if (!existingConn) {
        workflow.connections[sourceNode].main[sourceOutput].push({
          node: targetNode,
          type: "main",
          index: targetInput
        });
      }

      // Save back
      const response = await n8nApi.put(`/workflows/${workflowId}`, stripWorkflowForUpdate(workflow));
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Connected '${sourceNode}' -> '${targetNode}'`,
            workflowId
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "disconnect_nodes",
  "Remove a connection between two nodes",
  {
    workflowId: z.string().describe("Workflow ID"),
    sourceNode: z.string().describe("Name of the source node"),
    targetNode: z.string().describe("Name of the target node"),
    sourceOutput: z.number().optional().default(0).describe("Source output index (default: 0)"),
    targetInput: z.number().optional().default(0).describe("Target input index (default: 0)")
  },
  async ({ workflowId, sourceNode, targetNode, sourceOutput = 0, targetInput = 0 }) => {
    try {
      // Fetch current workflow
      const getResponse = await n8nApi.get(`/workflows/${workflowId}`);
      const workflow = getResponse.data;

      // Check if connection exists
      if (!workflow.connections?.[sourceNode]?.main?.[sourceOutput]) {
        return {
          content: [{
            type: "text",
            text: `Error: No connections from '${sourceNode}' output ${sourceOutput}`
          }],
          isError: true
        };
      }

      // Remove the connection
      const connections = workflow.connections[sourceNode].main[sourceOutput];
      const connIndex = connections.findIndex(
        (c: any) => c.node === targetNode && c.index === targetInput
      );

      if (connIndex === -1) {
        return {
          content: [{
            type: "text",
            text: `Error: Connection '${sourceNode}' -> '${targetNode}' not found`
          }],
          isError: true
        };
      }

      connections.splice(connIndex, 1);

      // Save back
      const response = await n8nApi.put(`/workflows/${workflowId}`, stripWorkflowForUpdate(workflow));
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Disconnected '${sourceNode}' -> '${targetNode}'`,
            workflowId
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "update_workflow_settings",
  "Update workflow settings without sending full workflow",
  {
    workflowId: z.string().describe("Workflow ID"),
    settings: z.record(z.string(), z.any()).describe("Settings to update (merged with existing)")
  },
  async ({ workflowId, settings }) => {
    try {
      // Fetch current workflow
      const getResponse = await n8nApi.get(`/workflows/${workflowId}`);
      const workflow = getResponse.data;

      // Merge settings
      workflow.settings = {
        ...workflow.settings,
        ...settings
      };

      // Save back
      const response = await n8nApi.put(`/workflows/${workflowId}`, stripWorkflowForUpdate(workflow));
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: "Workflow settings updated",
            workflowId,
            updatedSettings: Object.keys(settings)
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
);

// Security Audit Tool
server.tool(
  "generate_audit",
  "Generate a comprehensive security audit report for the n8n instance",
  {
    additionalOptions: z.object({
      daysAbandonedWorkflow: z.number().optional().describe("Number of days to consider a workflow abandoned"),
      categories: z.array(z.enum(["credentials", "database", "nodes", "filesystem", "instance"])).optional().describe("Audit categories to include")
    }).optional().describe("Additional audit configuration options")
  },
  async ({ additionalOptions }) => {
    try {
      const auditPayload: any = {};

      if (additionalOptions) {
        if (additionalOptions.daysAbandonedWorkflow !== undefined) {
          auditPayload.daysAbandonedWorkflow = additionalOptions.daysAbandonedWorkflow;
        }
        if (additionalOptions.categories) {
          auditPayload.categories = additionalOptions.categories;
        }
      }

      const response = await n8nApi.post('/audit', auditPayload);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: "Security audit generated successfully",
            audit: response.data
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("N8N Workflow Builder MCP server v0.11.0 running on stdio");
  console.error("Modern SDK 1.17.0 with 34 tools: 12 workflow + 8 granular updates + 3 execution + 7 tag + 3 credential + 1 audit");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
