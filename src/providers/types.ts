/**
 * Infrastructure provider interface.
 *
 * A provider knows how to create, manage, and destroy machines.
 * It does NOT know about agent runtimes (OpenClaw, Hermes, etc).
 */

export interface Machine {
  id: string;
  name: string;
  state: "initializing" | "starting" | "running" | "stopping" | "off" | "unknown";
  ip: string;
  region: string;
  created_at: string;
}

export interface ProviderAdapter {
  /** Provider identifier */
  name: string;

  /** Create a new machine with the given cloud-init script */
  createMachine(opts: {
    name: string;
    cloudInit: string;
    labels?: Record<string, string>;
  }): Promise<Machine>;

  /** Get machine status */
  getMachine(machineId: string): Promise<Machine>;

  /** List all managed machines */
  listMachines(): Promise<Machine[]>;

  /** Start a machine */
  startMachine(machineId: string): Promise<void>;

  /** Stop a machine */
  stopMachine(machineId: string): Promise<void>;

  /** Delete a machine */
  deleteMachine(machineId: string): Promise<void>;
}
