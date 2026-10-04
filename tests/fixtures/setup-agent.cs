using System;
using System.IO;
using System.Threading;

public class SetupAgent {
    public static int Main(string[] args) {
        string home = Environment.GetEnvironmentVariable("SETUP_TEST_AGENT_HOME");
        string command = args.Length > 0 ? args[0] : "";
        File.AppendAllText(Path.Combine(home, "calls.txt"), command + "\n");
        if (command == "--version") { Console.WriteLine("2026.09 fixture"); return 0; }
        if (command == "acp") { Console.WriteLine("agent acp --help"); return 0; }
        if (command == "status") {
            if (File.Exists(Path.Combine(home, "slow"))) Thread.Sleep(3000);
            string state = File.ReadAllText(Path.Combine(home, "state")).Trim();
            if (state == "unknown") { Console.Error.WriteLine("Network unavailable"); return 1; }
            Console.WriteLine(state == "signed-in" ? "Logged in as fixture@example.invalid" : "Not logged in");
            return state == "signed-in" ? 0 : 1;
        }
        if (command == "login") {
            if (File.Exists(Path.Combine(home, "cancel"))) return 1;
            File.WriteAllText(Path.Combine(home, "state"), "signed-in");
            return 0;
        }
        return 1;
    }
}
