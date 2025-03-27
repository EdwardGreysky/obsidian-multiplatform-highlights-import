import { IExtractor } from "../interfaces/IExtractor";
import { KoboHighlightsImporterSettings } from "../settings/Settings";
import { IBook, IBookWithHighlights } from "../interfaces/IBook";
import SqlJs, { Database } from "sql.js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error
import uint8array from "../binaries/sql-wasm.wasm";
import fs from "fs";
import path from "path";
import { IHighlight } from "../interfaces/IHighlight";
import { Notice } from "obsidian";
import AdmZip from "adm-zip";

export class MoonReaderExtractor implements IExtractor {
	name = "MoonReader";
	private tempDirectories: string[] = [];

	async extractHighlights(
		settings: KoboHighlightsImporterSettings
	): Promise<IBookWithHighlights[]> {
		try {
			this.tempDirectories = [];
			const SQLEngine = await SqlJs({
				wasmBinary: uint8array.buffer,
			});

			// Since we rely on the Moon+Reader backup files, we can't be sure where the database is located.
			// We'll search for it in the specified directory.
			const dbFilePath = await this.findMoonReaderDbFile(
				settings.moonreaderSqlitePath,
				SQLEngine
			);

			if (!dbFilePath) {
				new Notice(
					"MoonReader database file not found. Please check the path."
				);
				return [];
			}

			const fileBuffer = fs.readFileSync(dbFilePath);
			const db = new SQLEngine.Database(fileBuffer);

			const highlights = await this.getAllHighlights(db);

			const bookMap = new Map<string, IBook>();
			const highlightMap = new Map<string, IHighlight[]>();

			for (const highlight of highlights) {
				const bookTitle = (
					highlight.book || "Unknown Title"
				).toString();

				if (!bookMap.has(bookTitle)) {
					bookMap.set(bookTitle, {
						title: bookTitle,
						author: highlight.book_author || "Unknown Author",
						description: highlight.book_description || "",
						isbn: undefined,
						dateLastRead: new Date(
							parseInt(highlight.time) || Date.now()
						),
					});
				}

				if (!highlightMap.has(bookTitle)) {
					highlightMap.set(bookTitle, []);
				}

				if (!highlight.original && !highlight.bookmark) {
					continue;
				}

				const highlightText =
					highlight.original || highlight.bookmark || "";

				highlightMap.get(bookTitle)?.push({
					bookmarkId: highlight._id.toString(),
					chapterTitle:
						highlight.lastChapter.toString() || "Unknown Chapter",
					text: highlightText,
					note: highlight.note || "",
					dateCreated: new Date(
						parseInt(highlight.time) || Date.now()
					),
				});
			}

			const output: IBookWithHighlights[] = [];

			bookMap.forEach((book, title) => {
				const bookHighlights = highlightMap.get(title) || [];
				if (bookHighlights.length > 0) {
					output.push({
						book: book,
						highlights: bookHighlights,
					});
				}
			});

			return output;
		} catch (error) {
			console.error("Error extracting MoonReader highlights:", error);
			new Notice(
				"Failed to extract MoonReader highlights. Check the console for details."
			);
			return [];
		} finally {
			this.cleanupTempDirectories();
		}
	}

	private cleanupTempDirectories(): void {
		for (const dir of this.tempDirectories) {
			try {
				if (dir && fs.existsSync(dir)) {
					fs.rmSync(dir, { recursive: true, force: true });
					console.log(`Cleaned up temporary directory: ${dir}`);
				}
			} catch (e) {
				console.error("Error cleaning up temporary directories:", e);
			}
			this.tempDirectories = [];
		}
	}

	private async findMoonReaderDbFile(
		directoryPath: string,
		SQLEngine: any
	): Promise<string | null> {
		try {
			const files = fs.readdirSync(directoryPath);
			let tempFilePath = directoryPath;
			const subDir = "com.flyersoft.moonreader";

			const mrstdFiles = files.filter((file) => file.endsWith(".mrstd"));

			if (mrstdFiles.length > 0) {
				mrstdFiles.sort().reverse();

				for (const mrstdFile of mrstdFiles) {
					const mrstdPath = path.join(directoryPath, mrstdFile);
					try {
						const tempDir = await this.extractMrstdArchive(
							mrstdPath
						);

						if (tempDir) {
							this.tempDirectories.push(tempDir);
							tempFilePath = tempDir;
						}
					} catch (e) {
						console.error(
							`Failed to process backup file ${mrstdPath}:`,
							e
						);
						continue;
					}
				}
			}

			const SQLITE_HEADER = "SQLite format 3";
			const finalDirectoryPath = path.join(tempFilePath, subDir);
			const exportedFiles = fs.readdirSync(finalDirectoryPath);

			for (const file of exportedFiles) {
				const filePath = path.join(finalDirectoryPath, file);

				if (fs.statSync(filePath).isDirectory()) {
					continue;
				}

				try {
					// Read the first 16 bytes to check SQLite signature
					const fd = fs.openSync(filePath, "r");
					const buffer = Buffer.alloc(16);
					fs.readSync(fd, buffer, 0, 16, 0);
					fs.closeSync(fd);

					const header = buffer.toString("utf-8", 0, 15);
					if (header === SQLITE_HEADER) {
						// It's a SQLite file, check if it has the right tables
						const db = new SQLEngine.Database(
							fs.readFileSync(filePath)
						);

						try {
							const tables = this.listTables(db);
							if (tables.includes("notes")) {
								console.log(
									`Found MoonReader database: ${filePath}`
								);
								return filePath;
							}
						} catch (e) {
							// Not the right database, try the next file
							continue;
						}
					}
				} catch (e) {
					// Skip files that can't be read or aren't valid SQLite
					continue;
				}
			}

			return null;
		} catch (error) {
			console.error("Error searching for MoonReader database:", error);
			return null;
		}
	}

	private async extractMrstdArchive(
		archivePath: string
	): Promise<string | null> {
		try {
			const basename = path.basename(archivePath, ".mrstd");
			const tempDir = path.join(
				path.dirname(archivePath),
				`temp_${basename}`
			);

			try {
				if (!fs.existsSync(tempDir)) {
					fs.mkdirSync(tempDir, { recursive: true });
				}
				const zip = new AdmZip(archivePath);
				zip.extractAllTo(tempDir, true);
			} catch (e) {
				console.error(`Failed to extract archive ${archivePath}:`, e);
				return null;
			}

			return tempDir;
		} catch (error) {
			console.error(`Error extracting archive ${archivePath}:`, error);
			return null;
		}
	}

	private listTables(db: Database): string[] {
		try {
			const tables: string[] = [];
			const stmt = db.prepare(
				"SELECT name FROM sqlite_master WHERE type='table'"
			);

			while (stmt.step()) {
				const row = stmt.getAsObject();
				if (row.name) {
					tables.push(row.name.toString());
				}
			}

			stmt.free();
			return tables;
		} catch (e) {
			console.error("Error listing tables:", e);
			return [];
		}
	}

	private async getAllHighlights(db: Database): Promise<any[]> {
		const hasBookAuthor = this.checkTableExists(db, "books");

		// Build the query based on the actual schema
		let query =
			"SELECT n.* FROM notes n WHERE n.book IS NOT NULL ORDER BY n.time DESC";

		// If books table exists, join with it
		if (hasBookAuthor) {
			query = `
                SELECT 
                    n.*,
                    b.author as book_author,
                    b.description as book_description
                FROM notes n
                LEFT JOIN books b ON n.book = b.book
                WHERE n.book IS NOT NULL
                ORDER BY n.time DESC
            `;
		}

		try {
			const statement = db.prepare(query);
			const results: any[] = [];

			while (statement.step()) {
				const row = statement.getAsObject();
				results.push(row);
			}

			statement.free();
			return results;
		} catch (error) {
			console.error("Error executing query:", error);
			throw error;
		}
	}

	private checkTableExists(db: Database, tableName: string): boolean {
		try {
			const stmt = db.prepare(
				"SELECT name FROM sqlite_master WHERE type='table' AND name=?"
			);
			stmt.bind([tableName]);
			const exists = stmt.step();
			stmt.free();
			return exists;
		} catch (e) {
			return false;
		}
	}

	// Not used for now, but could be useful in the future

	// private getHighlightColorName(colorCode: number): string {
	// 	if (colorCode === 1996532479) return "yellow";
	// 	if (colorCode === -3368512) return "green";
	// 	if (colorCode === -3373624) return "blue";
	// 	if (colorCode === -3621789) return "red";
	// 	if (colorCode === -6543440) return "purple";
	// 	return "default";
	// }
}
